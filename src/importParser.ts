/**
 * 微信群赴宴名单解析器
 *
 * 输入：从微信群聊里整段复制的名单文本，一行可能是：
 *   张三 带老婆一个小孩
 *   李四（单位：教育局，13800138000）
 *   王五夫妇  2大1小
 *   赵六一家三口
 *   孙七 教育局 138 0013 8000 单位同事
 *
 * 输出：按行拆分的主客/随行/小孩条目 + 剔除内容（手机/单位/微信/邮箱）
 *       + 必须人工核对的问题（生僻字、无法识别、重名等，问题一律带行号）
 */

export type ParsedRole = 'main' | 'companion' | 'child';

export type ParsedPerson = {
  /** 向导里临时使用的 key，不是最终 guest id */
  key: string;
  sourceLine: number;
  role: ParsedRole;
  name: string;
  /** 随行身份，如「爱人」「家属」，仅 role=companion 有 */
  relation?: string;
  childSeat: boolean;
  /** 系统从原文里带出来的标签（同事/同学/男方亲属…） */
  tags: string[];
  /** 是否为「一家三口」这类没有明确写法、按惯例推测的随行 */
  inferred?: boolean;
};

export type IssueKind =
  | 'unknown-char' // 名字里有认不出的字
  | 'no-name' // 这一行没找到姓名
  | 'ambiguous' // 说法含糊（如「携全家」），人数靠推测
  | 'multi-name' // 一行里像是写了多个人名
  | 'dup-in-paste' // 本段文本里名字出现两次
  | 'dup-existing'; // 和名单里已有的人同名

export type IssueLevel = 'error' | 'warning';

export type ParseIssue = {
  id: string;
  kind: IssueKind;
  level: IssueLevel;
  line: number;
  personKey?: string;
  /** 与谁相关（重名时另一个条目的 key） */
  relatedKey?: string;
  /** 与名单里已有宾客重名时的现有姓名 */
  existingName?: string;
  message: string;
  /** 触发问题的原文片段，方便对照 */
  fragment?: string;
};

export type StrippedItem = {
  kind: 'phone' | 'wechat' | 'email' | 'org';
  value: string;
  line: number;
};

export type ParsedRow = {
  line: number;
  raw: string;
  persons: ParsedPerson[];
  stripped: StrippedItem[];
  /** 这一行被整体跳过（如「不去了」），仍展示在预览里 */
  skipped?: string;
};

export type ParseResult = {
  rows: ParsedRow[];
  issues: ParseIssue[];
  stripped: StrippedItem[];
};

/* ----------------------------- 基础工具 ----------------------------- */

const CN_DIGIT: Record<string, number> = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

function toDigit(s: string): number | null {
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  if ([...s].length === 1 && s in CN_DIGIT) return CN_DIGIT[s];
  if (s === '十') return 10;
  if (s.startsWith('十') && s.length === 2 && s[1] in CN_DIGIT) return 10 + CN_DIGIT[s[1]];
  if (s.endsWith('十') && s.length === 2 && s[0] in CN_DIGIT) return CN_DIGIT[s[0]] * 10;
  if (s.length === 3 && s[1] === '十' && s[0] in CN_DIGIT && s[2] in CN_DIGIT) {
    return CN_DIGIT[s[0]] * 10 + CN_DIGIT[s[2]];
  }
  return null;
}

/** 全角转半角 */
function normalize(s: string): string {
  return s
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[Ａ-Ｚａ-ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/　/g, ' ');
}

let seq = 0;
const nextId = () => `p${Date.now().toString(36)}_${(seq++).toString(36)}`;

/* ----------------------------- 多余内容识别 ----------------------------- */

/** 手机号（允许中间空格/横线，如 138 0013 8000），座机（010-xxxxxxxx） */
const PHONE_RE =
  /(?:(?:手机|电话|联系方式|联系|tel|TEL)[:：\s]*)?(?:1[\s-]?[3-9](?:[\s-]?\d){9}|0\d{2,3}[\s-]?\d{7,8})/g;

const WECHAT_RE = /(?:微信|vx|VX|v信|V信|wechat|WeChat)[:：\s]*([A-Za-z][-_A-Za-z0-9]{5,19})/g;
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

/** 明确的单位写法：单位/公司/学校 + 冒号 + 名称 */
const ORG_LABEL_RE =
  /(?:工作单位|所在单位|单位|公司|学校|医院|局|厂)[:：]\s*([一-龥A-Za-z0-9（）()·\-]{2,20})/g;
/** 带完整机构后缀的写法：xx有限公司 / xx教育局 / xx人民医院 …… */
const ORG_SUFFIX_RE =
  /[一-龥A-Za-z0-9·\-]{2,}(?:有限公司|股份有限公司|有限责任公司|集团公司|教育局|卫生局|公安局|管理局|事业单位|研究所|研究院|人民医院|中医院|附属医院|科技公司|贸易公司|建筑公司|地产公司|卫生院)/g;
/** 裸机构名词：教育局 / 住建局 / 城关镇政府 ……（前缀至少 2 字；带职务后缀的称呼如「张局长」另行排除） */
const ORG_BARE_RE =
  /(?:^|[\s,，、;；/（）()【】\[\]])([一-龥A-Za-z]{2,}(?:局|分局|公司|办公室|委员会|部|院|校|系|处|科|所|队|站|行|会|厂|店|社|集团|政府|街道办|村委会))(?=$|[\s,，、;；/（）()【】\[\]])/g;

/** 「张局长」「李主任」这类带职务的称呼：把整段称呼挖空（剩单字姓无法成名人选） */
const PERSON_TITLE_RE =
  /[一-龥]{1,3}(局长|处长|科长|部长|院长|校长|所长|队长|站长|行长|厅长|司长|股长|组长|主任|书记|经理|总监|主管)/g;

/** 联系方式/机构标签词：去掉具体内容后，标签本身也要剔除，否则会被当人名 */
const LABEL_WORD_RE = /(?:邮箱|电子邮件|email|Email|EMAIL|微信号|工作单位|所在单位|单位名称)/g;

/** 明确是拒席/请假的说法 */
const DECLINE_RE = /(不来了|到不了|来不了|请假|缺席|不去了|无法出席|不能到场|有事来不了)/;

const TAG_WORDS = ['男方亲属', '女方亲属', '同事', '同学', '儿童', '素食'];

/** 机构泛词，单独出现时不是姓名 */
const ORG_GENERIC_WORDS = new Set([
  '单位', '公司', '机关', '企业', '部门', '科室', '办公室', '上班', '工作', '工厂', '学校', '医院',
  '邮箱', '电子邮件', '微信', '微信号', '手机号', '电话', '联系方式',
]);

/** 群聊里的常见语气/接龙噪音，不应当成人名 */
const CHAT_NOISE = new Set([
  '收到', '谢谢', '感谢', '好的', '明白', '知道', '参加', '出席', '一定', '准时', '没问题',
  '报名', '确认', '辛苦', '大家', '各位', '群主', '接龙', '统计', '名单', '待定', '暂定',
  '已转', '转账', '红包', '恭喜', '新婚', '快乐', '可以', '不行', '嗯嗯', '收到收到',
  '都来', '都去', '都会来', '到场', '应到', '实到', '必到', '过来', '要来', '会来',
]);

/** 行首列表序号：1. / 1、 / （1） / ① / 一、 …… */
const LIST_PREFIX_RE =
  /^\s*(?:\d{1,2}[.、)）]?|[①②③④⑤⑥⑦⑧⑨⑩⑪⑫]|[（(]\d{1,2}[)）]|[一二三四五六七八九十]{1,3}[、.])\s*/;

/* ----------------------------- 人数说法识别 ----------------------------- */

type CountResult = {
  companions: number;
  children: number;
  relation?: string;
  ambiguous?: boolean;
  /** 匹配到的片段跨度，用于从分句中剔除 */
  spans: [number, number][];
  /** 命中「都/均」：人数说法适用于一行里所有人 */
  appliesToAll?: boolean;
};

const cap = (n: number) => Math.max(0, Math.min(9, n));

const PARENT_RELATIONS = new Set(['父母', '爸妈', '老爸老妈', '双亲']);

/**
 * 从一个分句里识别「带几个人、几个小孩」的说法。
 * 识别顺序：夫妻 → 全家/N口 → N大M小 → 小孩 → 亲属称谓 → +N → 带N人。
 */
function extractCounts(clause: string): CountResult {
  const res: CountResult = { companions: 0, children: 0, spans: [] };
  let s = clause;

  /** 按正则收集命中片段并从原文挖空（挖空部分填等长空格，索引保持不变） */
  const cut = (re: RegExp, fn: (m: RegExpExecArray) => void) => {
    re.lastIndex = 0;
    const local: [number, number][] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(s))) {
      local.push([m.index, m.index + m[0].length]);
      fn(m);
      if (m[0].length === 0) re.lastIndex++;
    }
    for (const [i, j] of [...local].sort((a, b) => b[0] - a[0])) {
      s = s.slice(0, i) + ' '.repeat(j - i) + s.slice(j);
    }
    res.spans.push(...local);
  };

  // 夫妻 / 夫妇 / 两口子
  cut(/(夫妻|夫妇|夫妻俩|小两口|两口子|两口)/g, () => {
    if (res.companions === 0) {
      res.companions = 1;
      res.relation = '爱人';
    }
  });

  // 携全家 / 全家出席 / 一家人都来（人数不明，需人工核对）
  cut(/(携|带|领着)?(全家|一家子|一家人)(?:都来|出席|到场|参加)?/g, () => {
    if (res.companions === 0) res.companions = 1;
    res.ambiguous = true;
  });

  // 一家三口 / 一家4口 / 四口之家 / 全家三口
  cut(/(?:一家|全家)?\s*([一二两三四五六七八九\d])\s*口(?:之[家子])?/g, (m) => {
    const total = toDigit(m[1]);
    if (total && total >= 2) {
      res.companions = cap(total - 1);
      res.ambiguous = true;
    }
  });
  cut(/一家\s*([一二两三四五六七八九\d])\s*人/g, (m) => {
    const total = toDigit(m[1]);
    if (total && total >= 2) {
      res.companions = cap(total - 1);
      res.ambiguous = true;
    }
  });
  // 明确人数：共3人 / 一共4人 / 总计10人（必须带前缀，避免吃掉「加2人」）
  cut(/(?:共|一共|总计|总共)\s*([一二两三四五六七八九\d])\s*人(?![口子家])/g, (m) => {
    const total = toDigit(m[1]);
    if (total && total >= 2 && res.companions === 0) res.companions = cap(total - 1);
  });

  // 2大1小 / 两大一小
  cut(/([一二两三四五六七八九\d])\s*[大个成人]\s*([一二两三四五六七八九\d])\s*[小个孩娃]|([一二两三四五六七八九\d])\s*小(?![孩娃子])/g, (m) => {
    if (m[1] !== undefined) {
      const adults = toDigit(m[1]);
      const kids = toDigit(m[2]);
      if (adults) res.companions = Math.max(res.companions, cap(adults - 1));
      if (kids) res.children = Math.max(res.children, cap(kids));
    } else if (m[3] !== undefined) {
      const kids = toDigit(m[3]);
      if (kids) res.children = Math.max(res.children, cap(kids));
    }
  });

  // N个小孩 / 一个宝宝 / 娃 / 小朋友
  cut(/([一二两三四五六七八九\d])?\s*个?\s*(小孩|孩子|小朋友|宝宝|娃)/g, (m) => {
    const n = m[1] ? toDigit(m[1]) : 1;
    res.children = Math.max(res.children, cap(n || 1));
  });

  // 亲属称谓（父母算两人）
  cut(/(爱人|老婆|妻子|太太|夫人|老公|丈夫|对象|女朋友|男朋友|未婚妻|未婚夫|父母|爸妈|老爸老妈|双亲|母亲|父亲|老妈|老爸|爹|娘)(?:一[人位个])?/g, (m) => {
    if (PARENT_RELATIONS.has(m[1])) {
      res.companions = Math.max(res.companions, 2);
      res.relation = m[1];
    } else {
      res.companions = Math.max(res.companions, 1);
      res.relation = res.relation || m[1];
    }
  });

  // 家属 / 家人（一个人）
  cut(/(家属|家人)(?:一[人位个])?/g, () => {
    res.companions = Math.max(res.companions, 1);
    res.relation = res.relation || '家属';
  });

  // +1 / +2 / 加1人
  cut(/[+＋]\s*([一二两三四五六七八九\d])\s*(?:人|位|个)?/g, (m) => {
    const n = toDigit(m[1]);
    if (n) res.companions = Math.max(res.companions, cap(n));
  });

  // 带N人 / 携N位 / 加N人 / 陪同N人（避开「带一个小孩」）
  cut(/(带|携|领着|陪同|随行|另带|外加|加|加上)\s*([一二两三四五六七八九\d])\s*(人|位|个)(?!\s*(?:小孩|孩子|小朋友|宝宝))/g, (m) => {
    const n = toDigit(m[2]);
    if (n) res.companions = Math.max(res.companions, cap(n));
  });
  // 带人 / 携家属 / 带一位（没有数字，默认 1 人）
  cut(/(带|携|领着)(?:家属|家人|一位|一人|同伴|朋友)(?!\s*(?:小孩|孩子|小朋友|宝宝))/g, () => {
    res.companions = Math.max(res.companions, 1);
  });

  if (/[都均]/.test(clause) && (res.companions > 0 || res.children > 0)) {
    res.appliesToAll = true;
  }

  return res;
}

/* ----------------------------- 姓名识别 ----------------------------- */

type NameToken = {
  text: string;
};

const SPLIT_RE = /[\s,，、;；/／|（）()【】\[\]]+/g;

/** 认不出的字：问号、方框、乱码占位、星号、字母 X 等 */
const UNKNOWN_TOKEN_RE = /[?？□■▢▯☆★✕✖❌�*＊Xx〇○]/;
const VALID_NAME_RE = /^[一-龥·\-]{2,4}$|^[一-龥]{2,4}[A-Za-z]{0,10}$|^[A-Za-z][A-Za-z .\-]{1,19}$/;
const TITLE_RE =
  /^(先生|女士|小姐|太太|夫人|经理|主任|局长|校长|院长|老师|教授|医生|博士|哥|姐|叔|姨|伯|婶|姑|舅)$/;
/** 裸机构名词判断（如「教育局」「住建局」） */
const BARE_ORG_RE =
  /^[一-龥A-Za-z]{3,}(?:局|分局|司|办公室|委员会|部|院|校|系|处|科|所|队|站|行|会|厂|店|社|集团|政府|街道办|村委会)$/;

type TokenKind = 'name' | 'unknown' | 'latin' | 'org' | 'other';

function classifyToken(raw: string): TokenKind {
  if (!raw) return 'other';
  if (TITLE_RE.test(raw)) return 'other';
  if (TAG_WORDS.includes(raw) || ORG_GENERIC_WORDS.has(raw) || CHAT_NOISE.has(raw)) return 'other';
  if (/^[一二两三四五六七八九十\d]+[人位个口大小]?$/.test(raw)) return 'other';
  if (BARE_ORG_RE.test(raw)) return 'org';
  if (VALID_NAME_RE.test(raw) && !UNKNOWN_TOKEN_RE.test(raw)) return 'name';
  // 含中文但夹了认不出的字
  if (/[一-龥]/.test(raw) && UNKNOWN_TOKEN_RE.test(raw.replace(/[·.\-]/g, ''))) return 'unknown';
  if (/^[A-Za-z][A-Za-z .\-]{1,19}$/.test(raw)) return 'latin';
  return 'other';
}

function tokenizeNames(s: string): NameToken[] {
  const parts = s.split(SPLIT_RE).map((x) => x.trim()).filter(Boolean);
  return parts.map((text) => ({ text }));
}

/* ----------------------------- 单行解析 ----------------------------- */

type ClauseInfo = {
  counts: CountResult;
  tokens: NameToken[];
  tagHits: string[];
};

function stripContacts(line: string, stripped: StrippedItem[], lineNo: number): string {
  let s = line;
  s = s.replace(WECHAT_RE, (_m, id) => {
    stripped.push({ kind: 'wechat', value: id, line: lineNo });
    return ' ';
  });
  s = s.replace(EMAIL_RE, (m) => {
    stripped.push({ kind: 'email', value: m, line: lineNo });
    return ' ';
  });
  s = s.replace(PHONE_RE, (m) => {
    const digits = m.match(/\d/g)?.join('') || '';
    if (digits) stripped.push({ kind: 'phone', value: digits, line: lineNo });
    return ' ';
  });
  s = s.replace(ORG_LABEL_RE, (_m, name) => {
    stripped.push({ kind: 'org', value: name, line: lineNo });
    return ' ';
  });
  s = s.replace(ORG_SUFFIX_RE, (m) => {
    stripped.push({ kind: 'org', value: m, line: lineNo });
    return ' ';
  });
  s = s.replace(ORG_BARE_RE, (_m, name) => {
    stripped.push({ kind: 'org', value: name, line: lineNo });
    return ' ';
  });
  // 联系方式/单位标签词、带职务称呼，挖空避免被当姓名
  s = s.replace(PERSON_TITLE_RE, (m) => ' '.repeat(m.length));
  s = s.replace(LABEL_WORD_RE, (m) => ' '.repeat(m.length));
  return s;
}

/** 解析去掉联系方式后的一行 */
function parseLine(lineNo: number, raw: string, row: ParsedRow, issues: ParseIssue[]) {
  let s = normalize(raw).replace(LIST_PREFIX_RE, '');

  if (DECLINE_RE.test(s)) {
    row.skipped = '本人表示不来 / 请假';
    return;
  }

  s = stripContacts(s, row.stripped, lineNo);

  // 群聊回复噪音：收到 / 谢谢 / 都来 / 辛苦啦……（按词整体挖空，避免「都来」被当成第二个人名）
  const noiseWords = [...CHAT_NOISE].sort((a, b) => b.length - a.length);
  const noiseRe = new RegExp(`(?:^|[\\s,，、;；/（）()【】\\[\\]])(${noiseWords.join('|')})+|(${noiseWords.join('|')})+(?=$|[\\s,，、;；/（）()【】\\[\\]])`, 'g');
  s = s.replace(noiseRe, (m) => ' '.repeat(m.length));

  // 按逗号/顿号/分号/斜杠切成「分句」，人数说法就近跟随姓名
  const clauseTexts = s.split(/[,，、;；/]+/).map((x) => x.trim()).filter(Boolean);
  const clauseInfos: ClauseInfo[] = [];
  for (const ct of clauseTexts) {
    const counts = extractCounts(ct);
    // 把命中的人数说法挖空，再找姓名
    let rest = ct;
    for (const [a, b] of [...counts.spans].sort((x, y) => y[0] - x[0])) {
      rest = rest.slice(0, a) + ' '.repeat(b - a) + rest.slice(b);
    }
    const tagHits = TAG_WORDS.filter((t) => rest.includes(t));
    rest = tagHits.reduce((acc, t) => acc.split(t).join(' '), rest);
    const tokens = tokenizeNames(rest);
    clauseInfos.push({ counts, tokens, tagHits });
  }

  // 收集机构裸词（各分句里 token 级别的剔除）
  for (const c of clauseInfos) {
    c.tokens = c.tokens.filter((t) => {
      if (classifyToken(t.text) === 'org') {
        if (!row.stripped.some((x) => x.value === t.text)) {
          row.stripped.push({ kind: 'org', value: t.text, line: lineNo });
        }
        return false;
      }
      return true;
    });
  }

  // 汇总「都/均」式的全局人数说法
  const allCounts: CountResult = { companions: 0, children: 0, spans: [] };
  let appliesToAll = false;
  for (const c of clauseInfos) {
    if (c.counts.appliesToAll) {
      appliesToAll = true;
      allCounts.companions = Math.max(allCounts.companions, c.counts.companions);
      allCounts.children = Math.max(allCounts.children, c.counts.children);
      allCounts.relation = allCounts.relation || c.counts.relation;
      allCounts.ambiguous = allCounts.ambiguous || c.counts.ambiguous;
    }
  }

  // 收集姓名候选（跨分句去重）
  const mainTokens: { token: NameToken; kind: TokenKind }[] = [];
  for (const c of clauseInfos) {
    for (const t of c.tokens) {
      const kind = classifyToken(t.text);
      if (kind === 'name' || kind === 'unknown' || kind === 'latin') {
        if (!mainTokens.some((x) => x.token.text === t.text)) mainTokens.push({ token: t, kind });
      }
    }
  }

  if (mainTokens.length === 0) {
    // 整行没有姓名：只剩数字/标点空白就静默跳过，否则报「没认出姓名」
    const leftover = s.replace(/[\s\d，,。.、;；:：+＋带携陪同随行家属家人小孩孩子夫妻夫妇两位个口大小男女\-/／|（）()【】\[\]"'·]/g, '');
    if (leftover.trim()) {
      issues.push({
        id: nextId(),
        kind: 'no-name',
        level: 'error',
        line: lineNo,
        message: `第 ${lineNo} 行没认出姓名（可能是群聊回复或写法特殊）：「${raw.trim()}」`,
        fragment: raw.trim().slice(0, 30),
      });
    }
    return;
  }

  if (mainTokens.length > 1) {
    issues.push({
      id: nextId(),
      kind: 'multi-name',
      level: 'warning',
      line: lineNo,
      message: `第 ${lineNo} 行像是写了多个人名（${mainTokens.map((t) => t.token.text).join('、')}），已拆成多行，请核对`,
      fragment: raw.trim().slice(0, 30),
    });
  }

  for (const { token, kind } of mainTokens) {
    const personKey = nextId();
    const tags = Array.from(new Set(clauseInfos.flatMap((c) => c.tagHits)));

    // 人数归属：优先本姓名所在分句；其次「都/均」的全局说法
    const ownClause = clauseInfos.find((c) => c.tokens.some((t) => t.text === token.text));
    const counts: CountResult =
      ownClause && (ownClause.counts.companions > 0 || ownClause.counts.children > 0)
        ? ownClause.counts
        : appliesToAll
          ? allCounts
          : { companions: 0, children: 0, spans: [] };

    row.persons.push({
      key: personKey,
      sourceLine: lineNo,
      role: 'main',
      name: token.text,
      tags,
      childSeat: false,
    });

    if (kind === 'unknown') {
      issues.push({
        id: nextId(),
        kind: 'unknown-char',
        level: 'error',
        line: lineNo,
        personKey,
        fragment: token.text,
        message: `第 ${lineNo} 行姓名「${token.text}」里有认不出的字，请对照原文核对`,
      });
    } else if (kind === 'latin') {
      issues.push({
        id: nextId(),
        kind: 'unknown-char',
        level: 'warning',
        line: lineNo,
        personKey,
        fragment: token.text,
        message: `第 ${lineNo} 行的「${token.text}」是外文/拼音，请确认是不是姓名`,
      });
    }

    // 随行：父母两人时分别命名
    if (counts.relation && PARENT_RELATIONS.has(counts.relation) && counts.companions >= 2) {
      row.persons.push({
        key: nextId(),
        sourceLine: lineNo,
        role: 'companion',
        name: `${token.text}父亲`,
        relation: '父亲',
        tags,
        childSeat: false,
        inferred: counts.ambiguous,
      });
      row.persons.push({
        key: nextId(),
        sourceLine: lineNo,
        role: 'companion',
        name: `${token.text}母亲`,
        relation: '母亲',
        tags,
        childSeat: false,
        inferred: counts.ambiguous,
      });
    } else {
      for (let i = 0; i < counts.companions; i++) {
        const relation = counts.relation || '家属';
        row.persons.push({
          key: nextId(),
          sourceLine: lineNo,
          role: 'companion',
          name: `${token.text}${relation}${counts.companions > 1 ? i + 1 : ''}`,
          relation,
          tags,
          childSeat: false,
          inferred: counts.ambiguous,
        });
      }
    }

    for (let i = 0; i < counts.children; i++) {
      row.persons.push({
        key: nextId(),
        sourceLine: lineNo,
        role: 'child',
        name: `${token.text}小孩${counts.children > 1 ? i + 1 : ''}`,
        tags: ['儿童', ...tags.filter((t) => t !== '儿童')],
        childSeat: true,
        inferred: counts.ambiguous,
      });
    }

    if (counts.ambiguous) {
      issues.push({
        id: nextId(),
        kind: 'ambiguous',
        level: 'warning',
        line: lineNo,
        personKey,
        message: `第 ${lineNo} 行「${raw.trim().slice(0, 20)}」人数说法含糊（如「全家」「${
          counts.children + counts.companions + 1
        } 口人」），随行人数是按惯例拆的，请核对`,
        fragment: raw.trim().slice(0, 30),
      });
    }
  }
}

/* ----------------------------- 主入口 ----------------------------- */

export function parseGuestPaste(text: string, existingNames: string[] = []): ParseResult {
  const issues: ParseIssue[] = [];
  const stripped: StrippedItem[] = [];
  const rows: ParsedRow[] = [];

  const rawLines = text.split(/\r?\n/);
  rawLines.forEach((raw, i) => {
    const lineNo = i + 1;
    if (!raw.trim()) return;
    const row: ParsedRow = { line: lineNo, raw: raw.trim(), persons: [], stripped: [] };
    parseLine(lineNo, raw, row, issues);
    stripped.push(...row.stripped);
    if (row.persons.length > 0 || row.skipped || row.stripped.length > 0) rows.push(row);
  });

  // 本段文本内重名检测（只看主客）
  const byName = new Map<string, ParsedPerson[]>();
  for (const r of rows) {
    for (const p of r.persons) {
      if (p.role !== 'main') continue;
      if (!byName.has(p.name)) byName.set(p.name, []);
      byName.get(p.name)!.push(p);
    }
  }
  for (const [name, list] of byName) {
    if (list.length > 1) {
      issues.push({
        id: nextId(),
        kind: 'dup-in-paste',
        level: 'error',
        line: list[1].sourceLine,
        personKey: list[1].key,
        relatedKey: list[0].key,
        fragment: name,
        message: `「${name}」在本段名单里出现了两次（第 ${list
          .map((p) => p.sourceLine)
          .join('、')} 行），是同一家还是两个人？`,
      });
    }
  }

  // 与已有宾客重名
  const existing = new Set(existingNames.map((n) => n.trim()));
  const seen = new Set<string>();
  for (const r of rows) {
    for (const p of r.persons) {
      if (p.role !== 'main') continue;
      if (existing.has(p.name) && !seen.has(p.name)) {
        seen.add(p.name);
        issues.push({
          id: nextId(),
          kind: 'dup-existing',
          level: 'warning',
          line: p.sourceLine,
          personKey: p.key,
          existingName: p.name,
          fragment: p.name,
          message: `第 ${p.sourceLine} 行的「${p.name}」名单里已经有了，确认还要再导一次吗？`,
        });
      }
    }
  }

  issues.sort((a, b) => a.line - b.line || a.kind.localeCompare(b.kind));
  // 同一主客的同类提示去重（如「一家三口都来」会同时命中「N口」和「全家」）
  const dedup: ParseIssue[] = [];
  for (const iss of issues) {
    if (
      iss.kind === 'ambiguous' &&
      dedup.some((d) => d.kind === 'ambiguous' && d.personKey === iss.personKey)
    ) {
      continue;
    }
    dedup.push(iss);
  }
  return { rows, issues: dedup, stripped };
}

/** 统计解析结果里的人头数（跳过被勾掉的 person key） */
export function countParsedHeads(result: ParseResult, skipPersonKeys: Set<string>) {
  let adults = 0;
  let children = 0;
  let main = 0;
  for (const r of result.rows) {
    for (const p of r.persons) {
      if (skipPersonKeys.has(p.key)) continue;
      if (p.role === 'child') children++;
      else {
        adults++;
        if (p.role === 'main') main++;
      }
    }
  }
  return { adults, children, main, total: adults + children };
}
