export type GuestRole = 'main' | 'companion' | 'child';

export type Guest = {
  id: string;
  name: string;
  tags: string[];
  partySize: number;
  childSeat?: boolean;
  note?: string;
  /** 主客 / 随行 / 小孩，批量导入时拆分写入；手工添加默认为主客 */
  role?: GuestRole;
  /** 所属导入批次，用于整批退回与改动记录 */
  batchId?: string;
};

export type TableShape = 'round' | 'rect';

export type Table = {
  id: string;
  label: string;
  x: number;
  y: number;
  shape: TableShape;
  capacity: number;
  seatOrder: string[]; // guest ids, length <= capacity
};

export type RuleType = 'together' | 'apart' | 'adjacent' | 'separate';

export type Rule = {
  id: string;
  type: RuleType;
  a: string; // guest id
  b: string; // guest id
};

/** 名单改动记录（导入批次 / 整批退回） */
export type ChangeLogEntry = {
  id: string;
  /** 导入批次号，回滚与撤销时据此关联 */
  batchId: string;
  time: number;
  kind: 'import' | 'rollback';
  /** 概要，如「微信群名单导入 · 12 人」 */
  label: string;
  /** 明细：主客/随行/小孩人数、剔除条数等 */
  detail?: string;
  /** 本次导入的原始文本预览（前 80 字），方便核对贴错的是哪一批 */
  sourcePreview?: string;
  addedGuests?: number;
  removedGuests?: number;
  /** 回滚记录指向被退回的导入批次 */
  rolledBackFrom?: string;
};

export type Plan = {
  id: string;
  name: string;
  tables: Table[];
  guests: Guest[];
  rules: Rule[];
  updatedAt: number;
  /** 名单改动记录，新条目在最前 */
  changelog?: ChangeLogEntry[];
};

export type Command =
  | { type: 'updatePlan'; plan: Plan }
  | { type: 'updateTables'; tables: Table[] }
  | { type: 'updateGuests'; guests: Guest[] }
  | { type: 'updateRules'; rules: Rule[] }
  | { type: 'updateTable'; table: Table }
  | { type: 'addGuest'; guest: Guest }
  | { type: 'removeGuest'; guestId: string }
  | { type: 'addTable'; table: Table }
  | { type: 'removeTable'; tableId: string }
  | { type: 'moveGuest'; guestId: string; fromTableId: string | null; toTableId: string | null; toIndex?: number }
  /** 一次批量导入：原子写入宾客与改动记录 */
  | { type: 'importGuests'; guests: Guest[]; log: ChangeLogEntry }
  /** 整批退回：删除该批次全部宾客（连带座位与规则）并写一条回滚记录 */
  | { type: 'rollbackBatch'; batchId: string; log: ChangeLogEntry }
  | { type: 'batch'; commands: Command[] };

export const TAG_OPTIONS = ['男方亲属', '女方亲属', '同事', '同学', '儿童', '素食'];
