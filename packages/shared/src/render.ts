import { z } from 'zod';

/**
 * Контракт рендера. GDD §3.4, ART-BIBLE §2–3.
 *
 * Здесь только СХЕМЫ и типы: сами числа и цвета живут в
 * `packages/data` (palette.json, rigs/*.json). Причина та же, по которой
 * коэффициенты боя лежат в `balance.json` — правка цвета или пропорции
 * тела не должна быть правкой кода.
 *
 * GDD §3.4 говорит про это прямым текстом: «Риг из декларативной
 * спецификации. Тело собирается по JSON-описанию, а не хардкодом
 * в `buildRig`. Новый монстр или шлем = запись в данных, не правка кода.»
 */

/* ─────────────────────────────── палитра ─────────────────────────────── */

/**
 * Роли палитры — ровно строки таблицы ART-BIBLE §3.
 *
 * Записаны как перечисление, а не как свободная строка, чтобы новый цвет
 * нельзя было завести «мимо» арт-библии: он обязан отнести себя к одной
 * из шести ролей, и тест сверяет, что покрыты все шесть.
 */
export const PALETTE_ROLES = [
  'основа',
  'тень',
  'металл',
  'кожа-и-дерево',
  'кровь-и-опасность',
  'зараза-и-яд',
  'городское',
] as const;
export const paletteRoleSchema = z.enum(PALETTE_ROLES);
export type PaletteRole = z.infer<typeof paletteRoleSchema>;

export const paletteEntrySchema = z.object({
  /** sRGB, шесть шестнадцатеричных цифр. ART-BIBLE §6: цветовое пространство sRGB. */
  hex: z.string().regex(/^#[0-9a-f]{6}$/, 'ожидается #rrggbb строчными'),
  role: paletteRoleSchema,
  /** Слова арт-библии об этом цвете — чтобы правка была сверяема с документом. */
  note: z.string().min(1),
  /**
   * Цвет городского происхождения: тёплое золото и чистая белизна.
   *
   * ART-BIBLE §3: «Тёплое золото и чистая белизна зарезервированы
   * за вещами городского происхождения... Не тратить золото на обычный
   * лут. Оно должно быть редким, иначе перестанет значить.»
   *
   * Правило проверяется тестом: зарезервированный цвет разрешён только
   * узлам, помеченным `origin: "city"`.
   */
  reserved: z.boolean(),
});
export type PaletteEntry = z.infer<typeof paletteEntrySchema>;

function dropMeta(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(([key]) => !key.startsWith('$')),
  );
}

export const paletteSchema = z.preprocess(
  dropMeta,
  z.record(z.string(), paletteEntrySchema).refine((p) => Object.keys(p).length > 0, {
    message: 'палитра пуста',
  }),
);
export type Palette = z.infer<typeof paletteSchema>;

/* ──────────────────────────────── риг ────────────────────────────────── */

/**
 * Слоты экипировки. GDD §5.3: их восемь, и ВСЕ видны на риге —
 * «визуальный прогресс бесплатно».
 */
export const RIG_SLOTS = [
  'weapon',
  'offhand',
  'helmet',
  'chest',
  'bracers',
  'boots',
  'amulet',
  'ring',
] as const;
export const rigSlotSchema = z.enum(RIG_SLOTS);
export type RigSlot = z.infer<typeof rigSlotSchema>;

const vec3 = z.tuple([z.number(), z.number(), z.number()]);

/**
 * Форма узла.
 *
 * Коробка — основа стиля и остаётся умолчанием (GDD §3.4: «визуальный
 * стиль коробок из v1.0 сохраняется»). Две другие формы заведены
 * не «на будущее», а под конкретную задачу: раннесредневековый город
 * читается островерхими башнями и скатными крышами, а прямоугольные
 * башни одинаковой ширины с плоскими верхушками читаются как
 * современный мегаполис — что и показал первый скриншот M2a.
 *
 *  `box`     — коробка;
 *  `pyramid` — четырёхскатная пирамида: шатёр башни, шпиль;
 *  `gable`   — двускатная крыша: треугольная призма вдоль оси Z.
 */
export const RIG_SHAPES = ['box', 'pyramid', 'gable'] as const;
export const rigShapeSchema = z.enum(RIG_SHAPES);
export type RigShape = z.infer<typeof rigShapeSchema>;

/**
 * Узел рига — одна коробка.
 *
 * Стиль коробок из v1.0 сохраняется намеренно (GDD §3.4): это
 * идентичность проекта, а не техническое ограничение.
 */
export const rigNodeSchema = z.object({
  name: z.string().min(1),
  /** Имя родительского узла. `null` — корень. */
  parent: z.string().min(1).nullable(),
  /** Смещение от родителя, в метрах сцены. */
  offset: vec3,
  /** Габарит узла. Нулевой размер означает пустой узел-привязку. */
  size: vec3,
  /** Форма. По умолчанию коробка — стиль проекта. */
  shape: rigShapeSchema.optional(),
  /** Ключ цвета из палитры. */
  color: z.string().min(1),
  /** Слот экипировки, если узел изображает надетую вещь. */
  slot: rigSlotSchema.optional(),
  /**
   * Происхождение узла. `city` разрешает зарезервированные цвета
   * (ART-BIBLE §3) — так силуэт Мунды может светиться иначе, чем всё
   * остальное, и при этом правило остаётся проверяемым.
   */
  origin: z.literal('city').optional(),
  /**
   * Узел несёт источник света и попадает в реестр мерцающих.
   *
   * Мерцает СВЕТ, а не материал: материалы разделяются кэшем по цвету
   * (GDD §3.4), и правка материала одного факела изменила бы все объекты
   * того же цвета разом.
   */
  light: z
    .object({
      color: z.string().min(1),
      intensity: z.number().positive(),
      distance: z.number().positive(),
      /** Амплитуда мерцания, доля интенсивности. */
      flicker: z.number().min(0).max(1),
    })
    .optional(),
});
export type RigNode = z.infer<typeof rigNodeSchema>;

export const rigSpecSchema = z.object({
  id: z.string().min(1),
  $comment: z.string().optional(),
  /**
   * Риг никогда не двигается — слить его меши по материалу при сборке.
   *
   * Свойство ДАННЫХ, а не решение кода: неподвижен объект или нет, знает
   * тот, кто его описал. Слияние стирает иерархию узлов, поэтому оно
   * запрещено всему, к чему потом обращаются адресно: у бойца есть слоты
   * экипировки, у арены — жаровни со светом.
   *
   * Выигрыш прямой: силуэт города из двадцати двух коробок — это
   * двадцать два вызова отрисовки на объект, который не меняется
   * ни разу за бой. После слияния их столько, сколько у города тонов.
   */
  static: z.boolean().optional(),
  nodes: z.array(rigNodeSchema).min(1),
});
export type RigSpec = z.infer<typeof rigSpecSchema>;

/* ────────────────────────────── бюджеты ──────────────────────────────── */

/**
 * Бюджеты производительности. GDD §3.4, таблица.
 *
 * Лежат в контракте, а не в тесте, чтобы и тест, и скрипт замера, и CI
 * читали одни и те же числа. Бюджет, записанный в двух местах, через
 * месяц записан в двух РАЗНЫХ местах.
 */
export const RENDER_BUDGETS = {
  /** GDD §3.4: «Draw calls в бою < 120». */
  drawCalls: 120,
  /** GDD §3.4: «Бандл (gzip, без three.js) < 400 КБ». */
  bundleGzipBytes: 400 * 1024,
  /** Аллокаций за кадр в установившемся режиме. Ноль — не приближение. */
  allocationsPerFrame: 0,
} as const;

/* ───────────────────────────── анимации ──────────────────────────────── */

/**
 * Примитивы анимации. GDD §3.4 про риги из данных — здесь тот же приём.
 *
 * ГРАНИЦА, КОТОРУЮ НЕ НАДО ПЕРЕОЦЕНИВАТЬ. Из данных приходит, КАКИЕ
 * примитивы играют на событие и с какими параметрами: длительность,
 * смещение, цвет из палитры, число частиц. Сами примитивы — код,
 * и по-другому быть не может: движение нельзя описать данными,
 * не написав интерпретатор движения.
 *
 * Практическое следствие: новый эффект — запись в json, ЕСЛИ он
 * собирается из этих пяти. Принципиально новый вид движения потребует
 * шестого примитива, то есть правки кода. Заявлять «любая анимация
 * из данных» было бы неправдой.
 */
export const ANIMATION_PRIMITIVES = [
  /** Выпад бойца к противнику и обратно. */
  'lunge',
  /** Вспышка света у цели. Свет, а не материал: материалы общие. */
  'flash',
  /** Всплеск частиц. Один InstancedMesh на всю сцену. */
  'burst',
  /** Всплывающее число над целью. Пул DOM-узлов. */
  'number',
  /** Тряска: короткое смещение цели от удара. */
  'shake',
  /**
   * Падение: поворот бойца вокруг ступней. Единственный примитив,
   * который НЕ возвращается в исходное положение — иначе убитый
   * поднимался бы обратно.
   */
  'topple',
] as const;
export const animationPrimitiveSchema = z.enum(ANIMATION_PRIMITIVES);
export type AnimationPrimitive = z.infer<typeof animationPrimitiveSchema>;

/** К кому относится примитив: к тому, кто действует, или к цели. */
export const animationTargetSchema = z.enum(['actor', 'target']);
export type AnimationTarget = z.infer<typeof animationTargetSchema>;

export const animationStepSchema = z.object({
  primitive: animationPrimitiveSchema,
  on: animationTargetSchema,
  /** Задержка от начала события, миллисекунды. */
  delayMs: z.number().min(0),
  /** Длительность примитива, миллисекунды. */
  durationMs: z.number().positive(),
  /** Ключ цвета из палитры. */
  color: z.string().min(1).optional(),
  /** Амплитуда: метры для lunge и shake, радианы для topple, множитель для остальных. */
  amount: z.number().optional(),
  /** Число частиц для burst. */
  count: z.int().min(1).max(64).optional(),
});
export type AnimationStep = z.infer<typeof animationStepSchema>;

export const eventAnimationSchema = z.object({
  /**
   * Сколько времени событие занимает В РАСПИСАНИИ. Это НЕ сумма
   * длительностей примитивов: примитив может доигрывать поверх
   * следующего события, и обычно так и надо — иначе бой распадается
   * на отдельные позы.
   */
  holdMs: z.number().min(0),
  steps: z.array(animationStepSchema),
});
export type EventAnimation = z.infer<typeof eventAnimationSchema>;

const dropDollarKeys = (value: unknown): unknown =>
  typeof value === 'object' && value !== null
    ? Object.fromEntries(
        Object.entries(value as Record<string, unknown>).filter(([key]) => !key.startsWith('$')),
      )
    : value;

/**
 * Числа сцены, общие для всех анимаций.
 *
 * Они здесь по той же причине, по которой габариты тела лежат в ригах,
 * а коэффициенты боя — в balance.json: литерал в коде рендера — это
 * число, которое нельзя поправить, не тронув код (инвариант 5 по духу,
 * GDD §3.4 по букве).
 */
export const animationStageSchema = z.object({
  /** Узел рига, над которым всплывают числа. */
  numberAnchor: z.string().min(1),
  /** Узел рига, из которого бьют частицы. */
  burstAnchor: z.string().min(1),
  /** Базовая яркость вспышки. Множитель шага `amount` умножается на неё. */
  flashIntensity: z.number().positive(),
  /** Радиус вспышки в метрах. */
  flashDistance: z.number().positive(),
  /** Высота источника вспышки над основанием бойца, метры. */
  flashHeightM: z.number(),
  /** Частота тряски, герц. Выше — злее и короче. */
  shakeHz: z.number().positive(),
});
export type AnimationStage = z.infer<typeof animationStageSchema>;

export const animationSpecSchema = z.object({
  $comment: z.union([z.string(), z.array(z.string())]).optional(),
  /**
   * Множители скорости воспроизведения (GDD §10). Ноль означает
   * «мгновенно»: расписание не проигрывается, берётся конечное состояние.
   */
  speeds: z.array(z.number().min(0)).min(2),
  /** Общие числа сцены: якоря, яркость вспышки, частота тряски. */
  stage: animationStageSchema,
  /** Анимация по типу события `BattleEvent['t']`. */
  events: z.preprocess(dropDollarKeys, z.record(z.string(), eventAnimationSchema)),
});
export type AnimationSpec = z.infer<typeof animationSpecSchema>;
