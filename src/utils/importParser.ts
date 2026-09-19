/**
 * 微信群赴宴名单解析器
 *
 * 输入：从微信群直接复制出来的整段文字（夹杂时间戳、发言人名、手机号、单位、
 * “带家属/带小孩”等口语表达、表情符号）。
 * 输出：结构化的宾客条目（主客 + 随行家属/小孩拆开），以及按行号给出的
 * 警告（认不出的字、疑似不来、识别到的多余信息等）。
 */

export type WarningLevel = 'error' | 'warn' | 'info';

export type ParseWarning = {
  level: WarningLevel;
  /** 问题出现在原文的第几行（从 1 开始） */
  line: number;
  message: string;
  /** 出错的原文片段，方便核对 */
  raw?: string;
};

export type ImportMember = {
  kind: 'primary' | 'adult' | 'child';
  /** 主客时是识别出的姓名；随行家属没有名字时为空串 */
  name: string;
  childSeat: boolean;
  relation: string; // 家属 / 爱人 / 小孩 ...
};

export type ParsedEntry = {
  id: string;
  line: number; // 对应原文行号
  raw: string; // 该行原文
  primaryName: string;
  members: ImportMember[];
  tags: string[];
  /** 从这行剔除掉的多余内容（手机号、单位等），预览时展示 */
  dropped: string[];
  status: 'ok' | 'absent' | 'pending';
  selected: boolean;
  warnings: string[];
};

export type ParseResult = {
  entries: ParsedEntry[];
  warnings: ParseWarning[];
  skipped: { line: number; raw: string; reason: string }[];
  primaryCount: number;
  adultCount: number;
  childCount: number;
};

let seq = 0;
function entryId(): string {
  seq += 1;
  return `pe_${Date.now().toString(36)}_${seq}`;
}

/** 匹配微信复制时的时间行，如 19:32、09:05、昨天 20:11 */
const TIME_LINE_RE = /^(?:(?:昨天|前天)\s*)?(?:[01]?\d|2[0-3])[:：][0-5]\d(?:[:：][0-5]\d)?$/;

/** “张三 19:32” 这种微信发言人+时间合并行 */
const SPEAKER_TIME_RE =
  /^(.{1,12}?)\s+(?:(?:昨天|前天)\s*)?(?:[01]?\d|2[0-3])[:：][0-5]\d(?::[0-5]\d)?$/;

/** 行首序号：1. / 1、 / 1) / （1） / ① / 一、 等 */
const LEADING_INDEX_RE =
  /^\s*(?:[（(]?\d{1,3}[）).、:：]?|[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮]|[一二三四五六七八九十]{1,3}[、.．])\s*/;

/** 纯粹是一个人名（用于判断微信发言人行） */
const BARE_NAME_RE = /^[一-龥]{2,4}$/;

const CN_DIGITS: Record<string, number> = {
  一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 俩: 2,
};

function parseCount(raw: string): number {
  if (/^\d+$/.test(raw)) return parseInt(raw, 10);
  if (raw === '俩') return 2;
  if (raw === '十') return 10;
  if (raw.startsWith('十')) return 10 + (CN_DIGITS[raw[1]] || 0);
  if (raw.endsWith('十')) return (CN_DIGITS[raw[0]] || 1) * 10;
  if (raw.length === 3 && raw[1] === '十') return (CN_DIGITS[raw[0]] || 0) * 10 + (CN_DIGITS[raw[2]] || 0);
  if (raw.length === 1) return CN_DIGITS[raw] || 0;
  return 0;
}

/** 手机号（允许中间有空格/连字符的复制格式，如 139 1234 5678） */
const PHONE_MOBILE_RE = /(?<![\d])1[3-9]\d(?:[\s-]?\d){4}(?:[\s-]?\d){4}(?![\d])/;
/** 座机（7~8 位，可带区号），避免误伤姓名 */
const PHONE_LOCAL_RE = /(?<![\d])(?:0\d{2,3}[-－\s]?)?\d{7,8}(?![\d])/;
/** 微信号 / QQ / 邮箱等联系方式，取值必须以字母/数字/@开头，避免吞掉中文姓名 */
const CONTACT_RE =
  /(?:微信号?|vx|vx号|wechat|qq|q\s*q|邮箱|e-?mail|tel|电话|手机|联系人)[:：\s]*[A-Za-z0-9][A-Za-z0-9_\-@.]{4,}/gi;
/** 网址 */
const URL_RE = /https?:\/\/\S+|www\.\S+/gi;

/** 表情符号（微信复制常见），变体选择符 U+FE0F 与零宽连字单独列出 */
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]|\u{FE0F}|\u{200D}/gu;

/** 单位 / 组织 */
const ORG_RE =
  /[一-龥A-Za-z0-9（）()·]{1,20}?(?:有限责任公司|股份有限公司|集团有限公司|有限公司|分公司|事务所|研究院|设计院|幼儿园|大学|学院|学校|中学|小学|医院|卫生院|银行|支行|分行|营业厅|派出所|村委会|居委会|办事处|管理局|住建局|财政局|教育局|税务局|公安局|检察院)/;

function isOrgText(content: string): boolean {
  return ORG_RE.test(content)
    || /公司|医院|学校|学院|大学|银行|集团|工厂|企业|事务所|幼儿园|中学|小学|研究院|设计院|派出所|居委会/.test(content)
    || /(局|厅|办|中心|站|所)$/.test(content);
}

/** 职务头衔（从姓名后面剥掉） */
const TITLE_RE =
  /(主任|经理|主管|科长|处长|局长|院长|校长|老师|教授|医生|博士|先生|女士|同志|总监|书记|厂长|队长|行长|会长|秘书长|工程师)$/;

/** “N 个小孩” */
const KIDS_RE = /(?:带|有|携|领着|抱着)?\s*(\d+|[一二两三四五六七八九十俩])\s*(?:个|名)?\s*(?:小孩|孩子|宝宝|娃|儿童)/;
/** 单个小孩（“带小孩”“有孩子”） */
const ONE_KID_RE = /(?:带|有|携|领着|抱着)\s*(?:一个?|两名?)?\s*(?:小孩|孩子|宝宝|娃|儿童)/;
/** “一家三口 / 一家四口”：多出的人里，1 个大人，其余小孩 */
const FAMILY_RE = /一家(三|四|五|六)口/;
/** “夫妻俩 / 夫妻俩 / 两口子”：主客 + 1 位大人 */
const COUPLE_RE = /夫妻俩?|俩夫妻|两口子|夫妻两人?/;
/** “3大1小 / 2 大 1 小”：N 个大人 M 个小孩（数字本身不计主客之外的口径，
 *  第一个“大”若包含主客本人，则大人随行数 = 大人数 - 1） */
const BIG_SMALL_RE = /(\d+|[一二两三四五六七八九十])\s*大\s*(\d+|[一二两三四五六七八九十])?\s*小/;

/** “带 N 位家属/朋友” */
const ADULT_COUNT_RE =
  /(?:带|有|携|偕)\s*(\d+|[一二两三四五六七八九十俩])\s*(?:位|个|名)?\s*(家属|家人|朋友|大人)/;
/** “带父母 / 带爱人”等（“先生”除外，避免误伤“张先生”） */
const ADULT_RELATION_RE =
  /(?:带|有|携|偕|和|跟)\s*([一-龥]{0,2}?(?:爱人|夫人|老公|老婆|丈夫|妻子|太太|对象|父母|爸妈|老爷子|老太太|两位老人|老人|家属|家人|朋友))/g;
const TWO_PARENTS_RE =
  /(?:带|有|携|偕)\s*(?:父母|爸妈|老爷子老太太|老人两个|两个老人|二老)/;

/** 明确不来 */
const ABSENT_RE = /(不去|来不了|去不了|没法参加|无法参加|不能参加|参加不了|赶不回来|到不了|不参加了)/;
/** 待定 */
const PENDING_RE = /(待定|还不确定|不确定|看情况|尽量到|尽量赶|可能来|或许来|暂定|先不报|再说吧)/;

/** 姓名结尾的出席动词 */
const TAIL_VERB_RE =
  /(要来参加|要来|要来参加|准时参加|一定参加|确定参加|报名参加|参加|出席|准时到|一定到|报名|登记|收到|确定来|一定来|会来)$/;

/** 主姓名：少数民族姓名（含间隔号）或 2~4 个汉字 */
const NAME_RE = /[一-龥]{1,2}·[一-龥]{2,6}|[一-龥]{2,4}/;

/** 认不出的字：□、�、囗 等缺字符号 */
const GLYPH_MISSING_RE = /[□�囗]/;

/** 括号内可识别的宾客标签 */
const BANNER_TAGS = ['男方亲属', '女方亲属', '同事', '同学', '素食', '家属', '儿童'];

/** 剔除联系方式、网址等，返回剔除下来的内容 */
function stripNoise(text: string): { clean: string; dropped: string[] } {
  const dropped: string[] = [];
  let clean = text;

  const collect = (re: RegExp, label: string) => {
    clean = clean.replace(re, (m) => {
      dropped.push(`${label}：${m.trim()}`);
      return ' ';
    });
  };

  collect(PHONE_MOBILE_RE, '手机号');
  collect(PHONE_LOCAL_RE, '电话号码');
  collect(CONTACT_RE, '联系方式');
  collect(URL_RE, '网址');

  return { clean, dropped };
}

/** 解析括号：标签收进 tags，单位/手机号剔进 dropped */
function processParentheses(text: string, dropped: string[], tags: string[]): string {
  return text.replace(/[（(]([^（）()]{1,30})[）)]/g, (whole, _inner: string) => {
    const content = _inner.trim();
    if (BANNER_TAGS.includes(content)) {
      tags.push(content);
      return ' ';
    }
    if (/男方|男家/.test(content)) {
      tags.push('男方亲属');
      return ' ';
    }
    if (/女方|女家/.test(content)) {
      tags.push('女方亲属');
      return ' ';
    }
    if (/素(食|菜)|吃素/.test(content)) {
      tags.push('素食');
      return ' ';
    }
    if (/不吃肉|全素|荤口|忌口/.test(content)) {
      tags.push('素食');
      return ' ';
    }
    if (/1[3-9]\d(?:[\s-]?\d){8}|(?<!\d)\d{7,8}(?!\d)/.test(content)) {
      dropped.push(`联系方式：${content}`);
      return ' ';
    }
    if (isOrgText(content)) {
      dropped.push(`单位：${content}`);
      return ' ';
    }
    if (/^备注|^注[:：]/.test(content)) {
      dropped.push(`备注：${content}`);
      return ' ';
    }
    return whole;
  });
}

/**
 * 一行里如果是“张三、李四、王五”这种纯姓名枚举（不含家属/小孩等信息），
 * 拆成多个条目；否则原样返回。
 */
function splitBareNames(line: string): string[] {
  if (/[，,]/.test(line) && /(带|家属|小孩|孩子|一家|夫妻|爱人)/.test(line)) return [line];
  const parts = line
    .split(/[、，,；;]/)
    .map((s) => s.replace(LEADING_INDEX_RE, '').trim())
    .filter(Boolean);
  if (parts.length < 2) return [line];
  // 全部片段都是“纯姓名（可带括号标签）”才拆
  const allBare = parts.every((p) => {
    const stripped = p
      .replace(/[（(][^（）()]{1,20}[）)]/g, '')
      .replace(EMOJI_RE, '')
      .trim();
    return BARE_NAME_RE.test(stripped);
  });
  if (!allBare) return [line];
  return parts;
}

/** 从一行文字里解析出一名主客及随行，返回 null 表示整行无法识别 */
function parseOne(
  line: number,
  rawLine: string,
  warnings: ParseWarning[],
): ParsedEntry | null {
  const entryWarnings: string[] = [];
  let text = rawLine.replace(EMOJI_RE, ' ').replace(/\s+/g, ' ').trim();
  text = text.replace(LEADING_INDEX_RE, '').trim();

  // 认不出的字（在剥噪声前先检查）
  if (GLYPH_MISSING_RE.test(text)) {
    warnings.push({
      level: 'error',
      line,
      message: `第 ${line} 行名字里有认不出的字（□/缺字符），请回到微信原文核对`,
      raw: rawLine,
    });
    entryWarnings.push('名字含认不出的字，需核对');
  }

  // 剔除手机号 / 微信号 / 网址
  const noise = stripNoise(text);
  text = noise.clean;
  const dropped = noise.dropped;

  // 括号处理
  const tags: string[] = [];
  text = processParentheses(text, dropped, tags);

  // 出席状态
  let status: ParsedEntry['status'] = 'ok';
  if (ABSENT_RE.test(text)) {
    status = 'absent';
    entryWarnings.push('这行写着不来/参加不了');
    warnings.push({ level: 'warn', line, message: `第 ${line} 行疑似不参加，已默认剔除`, raw: rawLine });
  } else if (PENDING_RE.test(text)) {
    status = 'pending';
    entryWarnings.push('这行写着待定');
    warnings.push({ level: 'warn', line, message: `第 ${line} 行状态待定，已保留但默认不勾选`, raw: rawLine });
  }

  // 解析随行：一家三口 / 夫妻俩
  const adults: { relation: string; n: number }[] = [];
  let childCount = 0;

  const familyM = text.match(FAMILY_RE);
  if (familyM) {
    const total = parseCount(familyM[1]); // 三/四/五/六
    const extra = total - 1;
    adults.push({ relation: '家属', n: 1 });
    childCount += Math.max(0, extra - 1);
    text = text.replace(familyM[0], ' ');
  }
  if (COUPLE_RE.test(text)) {
    adults.push({ relation: '爱人', n: 1 });
    text = text.replace(COUPLE_RE, ' ');
  }

  // 带父母（两位）要在普通关系词之前处理
  const twoParentM = text.match(TWO_PARENTS_RE);
  if (twoParentM) {
    adults.push({ relation: '父母', n: 2 });
    text = text.replace(twoParentM[0], ' ');
  }

  // N 个小孩
  const kidsM = text.match(KIDS_RE);
  if (kidsM) {
    childCount += parseCount(kidsM[1]);
    text = text.replace(kidsM[0], ' ');
  } else {
    const oneKidM = text.match(ONE_KID_RE);
    if (oneKidM) {
      childCount = 1;
      text = text.replace(oneKidM[0], ' ');
    }
  }

  // N 位家属
  const adultCountM = text.match(ADULT_COUNT_RE);
  if (adultCountM) {
    const n = parseCount(adultCountM[1]);
    const rel = adultCountM[2] === '大人' ? '家属' : adultCountM[2];
    adults.push({ relation: rel, n });
    text = text.replace(adultCountM[0], ' ');
  }

  // “3大1小 / 2大1小”：大人数含主客本人，故随行大人 = 大人数 - 1
  const bigSmallM = text.match(BIG_SMALL_RE);
  if (bigSmallM) {
    const big = parseCount(bigSmallM[1]);
    const small = bigSmallM[2] ? parseCount(bigSmallM[2]) : 0;
    if (big > 1) adults.push({ relation: '家属', n: big - 1 });
    childCount += small;
    text = text.replace(bigSmallM[0], ' ');
  }

  // 带爱人 / 带老公 / 带朋友 ...
  text = text.replace(ADULT_RELATION_RE, (_m, word: string) => {
    adults.push({ relation: word, n: 1 });
    return ' ';
  });

  // 清理标点，分出主姓名所在的头部
  text = text.replace(/[,，、；;：:]+/g, ' ').replace(/\s+/g, ' ').trim();

  // “我报名！张三 / 收到，李四 / 报名：王五” 这类寒暄前缀剥掉
  text = text.replace(
    /^(?:我|本人)?(?:要|想)?(?:报名|报到|登记|收到|参加|出席|确定|来啦?|来了|可以|没问题|好的?)[\s!！。.,，、：:～~]+/,
    '',
  );
  text = text.trim();

  const firstSpace = text.indexOf(' ');
  let head = firstSpace >= 0 ? text.slice(0, firstSpace) : text;
  let tail = firstSpace >= 0 ? text.slice(firstSpace + 1) : '';

  // 尾部找单位
  const tailOrgM = tail.match(ORG_RE);
  if (tailOrgM) {
    dropped.push(`单位：${tailOrgM[0]}`);
    tail = tail.replace(tailOrgM[0], ' ');
  }

  // 头部：本人/我是 前缀、出席动词后缀、头衔
  head = head.replace(/^(本人|我是|我叫|报名人|登记人)/, '');
  head = head.replace(TAIL_VERB_RE, '');
  head = head.replace(TITLE_RE, '');

  const nameM = head.match(NAME_RE);
  let primaryName = '';
  if (nameM) {
    primaryName = nameM[0];
    // 名字后面若还粘着单位名，剔掉
    const afterName = head.slice(nameM.index! + nameM[0].length);
    const orgM = afterName.match(ORG_RE);
    if (orgM) {
      dropped.push(`单位：${orgM[0]}`);
    } else if (/[一-龥]/.test(afterName)) {
      warnings.push({
        level: 'warn',
        line,
        message: `第 ${line} 行姓名「${primaryName}」后面还跟着未识别内容「${afterName}」，请核对`,
        raw: rawLine,
      });
      entryWarnings.push('姓名后有未识别内容');
    }
  }

  if (!primaryName) {
    warnings.push({ level: 'error', line, message: `第 ${line} 行没认出姓名，请手工核对`, raw: rawLine });
    return null;
  }

  if (primaryName.length < 2) {
    warnings.push({
      level: 'warn',
      line,
      message: `第 ${line} 行只认出一个姓「${primaryName}」，可能没识别全`,
      raw: rawLine,
    });
    entryWarnings.push('只认出一个姓，可能不完整');
  }

  const members: ImportMember[] = [
    { kind: 'primary', name: primaryName, childSeat: false, relation: '主客' },
  ];
  for (const a of adults) {
    for (let i = 0; i < a.n; i++) {
      members.push({ kind: 'adult', name: '', childSeat: false, relation: a.relation });
    }
  }
  for (let i = 0; i < childCount; i++) {
    members.push({ kind: 'child', name: '', childSeat: true, relation: '小孩' });
  }
  if (members.some((m) => m.kind === 'adult') && !tags.includes('家属')) tags.push('家属');

  return {
    id: entryId(),
    line,
    raw: rawLine,
    primaryName,
    members,
    tags,
    dropped,
    status,
    selected: status === 'ok',
    warnings: entryWarnings,
  };
}

/** 解析整段名单文本 */
export function parseGuestList(raw: string): ParseResult {
  const warnings: ParseWarning[] = [];
  const skipped: ParseResult['skipped'] = [];
  const entries: ParsedEntry[] = [];

  const rawLines = raw.split(/\r?\n/);

  // 预处理：找出微信“发言人名 + 时间”的组合，发言人那行要跳过
  const speakerLines = new Set<number>();
  for (let i = 0; i < rawLines.length; i++) {
    const cur = rawLines[i].trim();
    if (!cur) continue;
    const merged = cur.match(SPEAKER_TIME_RE);
    if (merged && BARE_NAME_RE.test(merged[1])) {
      speakerLines.add(i);
      continue;
    }
    if (TIME_LINE_RE.test(cur) && i > 0) {
      const prev = rawLines[i - 1].trim();
      if (BARE_NAME_RE.test(prev)) speakerLines.add(i - 1);
    }
  }

  for (let i = 0; i < rawLines.length; i++) {
    const lineNo = i + 1;
    const line = rawLines[i].trim();
    if (!line) continue;

    if (speakerLines.has(i)) {
      skipped.push({ line: lineNo, raw: line, reason: '微信发言人署名行' });
      continue;
    }
    if (TIME_LINE_RE.test(line)) continue;

    // 纯表情 / 标点行
    if (/^[\s\p{P}\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]+$/u.test(line)) {
      skipped.push({ line: lineNo, raw: line, reason: '空白/表情行' });
      continue;
    }

    const pieces = splitBareNames(line);
    for (const piece of pieces) {
      const parsed = parseOne(lineNo, piece, warnings);
      if (!parsed) {
        skipped.push({ line: lineNo, raw: piece, reason: '未识别到姓名' });
      } else {
        if (pieces.length > 1) parsed.raw = line;
        entries.push(parsed);
      }
    }
  }

  let adultCount = 0;
  let childCount = 0;
  for (const e of entries) {
    for (const m of e.members) {
      if (m.kind === 'child') childCount += 1;
      else adultCount += 1;
    }
  }

  return {
    entries,
    warnings,
    skipped,
    primaryCount: entries.length,
    adultCount,
    childCount,
  };
}

/** 同名检测结果（向导里据此停下来问） */
export type DuplicateGroup = {
  name: string;
  /** 已有名单中同名的宾客 id */
  existingGuestIds: string[];
  /** 本次粘贴中的条目 id（ParsedEntry.id） */
  entryIds: string[];
  /** 这些条目出现在原文的行号 */
  lines: number[];
  /** 用户的决定：same=同一家（合并），two=两个人（后一个加区分名） */
  resolution: 'same' | 'two' | null;
};

export function findDuplicates(
  entries: ParsedEntry[],
  existingGuests: { id: string; name: string }[],
): DuplicateGroup[] {
  const groups = new Map<string, DuplicateGroup>();
  const ensure = (name: string) => {
    let g = groups.get(name);
    if (!g) {
      g = { name, existingGuestIds: [], entryIds: [], lines: [], resolution: null };
      groups.set(name, g);
    }
    return g;
  };

  for (const g of existingGuests) {
    const base = g.name.replace(/（\d+）$/, '');
    if (/\p{Script=Han}/u.test(base)) ensure(base).existingGuestIds.push(g.id);
  }
  for (const e of entries) {
    if (e.primaryName) {
      const g = ensure(e.primaryName);
      g.entryIds.push(e.id);
      g.lines.push(e.line);
    }
  }

  return [...groups.values()].filter((g) => g.entryIds.length + g.existingGuestIds.length > 1);
}

/** 统计勾选导入的条目：大人数 / 小孩数 */
export function summarizeEntries(entries: ParsedEntry[]) {
  let adults = 0;
  let children = 0;
  for (const e of entries) {
    if (!e.selected) continue;
    for (const m of e.members) {
      if (m.kind === 'child') children += 1;
      else adults += 1;
    }
  }
  return { adults, children, total: adults + children };
}
