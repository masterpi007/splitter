// Member of a group. `userId` links a member row to a global User identity
// (present once the member has claimed a passkey). Legacy pre-existing
// members have userId === id.
export interface Member {
  id: string;
  userId?: string;
  name: string;
  avatarSeed?: string;
  // Optional bank account fields
  bankId?: string;
  bankName?: string;
  bankShortName?: string;
  accountName?: string;
  accountNo?: string;
  joinedAt?: string;
  removedAt?: string;
  // Weight factor for the default "Split" method. Missing/≤0 treated as 1.
  // Applied proportionally: Alice=2, Bob=1 → Alice pays 2/3, Bob pays 1/3.
  share?: number;
}

// Bank information
export interface Bank {
  id: string;
  name: string;
  shortName: string;
  appCode: string;
  logo: string;
}

// An expense group. `admins` is the list of member ids with admin rights
// (create invites, rename, remove members, transfer admin). `removedMembers`
// preserves history — members still referenced by old expenses remain resolvable.
export interface Group {
  id: string;
  name: string;
  currency: string;
  members: Member[];
  admins: string[];
  removedMembers: Member[];
  createdBy?: string;
  createdAt: string;
}

// Summary of a group as returned by GET /api/groups (one entry per membership).
export interface GroupSummary {
  id: string;
  name: string;
  memberId: string;
  memberCount: number;
  isAdmin: boolean;
}

// Permanent group invite.
export interface GroupInvite {
  code: string;
  groupId: string;
  createdBy: string;
  createdAt: string;
  note?: string;
}

// Split types
// 'group': splits the whole amount across all current group members using each
// member's configured share weight. No per-member splits are persisted —
// shares are recalculated on read from the current member list, so adding /
// removing members or changing share weights automatically re-weights past
// group spending.
export type SplitType = 'equal' | 'exact' | 'percentage' | 'shares' | 'settlement' | 'group';

// Discount types
export type DiscountType = 'percentage' | 'flat';

// Individual split within an expense
export interface ExpenseSplit {
  memberId: string;
  value: number; // meaning depends on splitType
  amount: number; // calculated actual amount
  signedOff: boolean;
  signedAt?: string;
  previousAmount?: number; // stored when amount changes and needs re-sign-off
}

// Sign-off record used by group-mode expenses, where per-member splits are
// derived dynamically. Tracks who has personally accepted the transaction;
// the "accepted" status flips once > 50% of active members are in this list.
export interface GroupSignOff {
  memberId: string;
  signedAt: string;
}

// Expense with sign-off tracking
export interface Expense {
  id: string;
  description: string;
  amount: number;
  paidBy: string; // member id
  createdBy: string; // member id who created the expense
  splitType: SplitType;
  splits: ExpenseSplit[];
  // Sign-off ledger for group-mode expenses (splits are computed on read, so
  // signedOff cannot live on each split). Empty/absent on non-group expenses.
  signedOffBy?: GroupSignOff[];
  items?: ReceiptItem[]; // stored items for editing later
  discount?: number; // percentage value OR flat amount, depending on discountType
  discountType?: DiscountType; // default 'percentage' for backward compat
  tags?: string[]; // user-defined tags
  createdAt: string;
  receiptUrl?: string;   // URL to receipt image in R2
  receiptDate?: string;  // Date extracted from receipt
}

// Receipt line item extracted from OCR
export interface ReceiptItem {
  id: string;
  description: string;
  amount: number;
  memberId?: string; // assigned member
}

// Receipt OCR result
export interface ReceiptOCRResult {
  success: boolean;
  extracted: {
    items: ReceiptItem[];
    date?: string;
    merchant?: string;
    discount?: number; // discount percentage (e.g., 10 for 10% off)
    total?: number;
    confidence: number;
  };
}

// API response types
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

// Balance calculation types
export interface MemberBalance {
  memberId: string;
  memberName: string;
  signedBalance: number; // balance from signed expenses
  pendingBalance: number; // balance from pending (unsigned) expenses
  balance: number; // total balance (signed + pending)
}

export interface Settlement {
  from: string;
  fromName: string;
  to: string;
  toName: string;
  amount: number;
}

// Auth types
export interface SessionInfo {
  userId: string;
  userName: string;
  expiresAt: string;
  // True when this user is an app-wide admin (APP_ADMIN_USER_IDS). Only
  // populated by GET /api/auth/session; undefined on freshly minted sessions.
  isAppAdmin?: boolean;
}

export interface AuthState {
  authenticated: boolean;
  session: SessionInfo | null;
  loading: boolean;
}

export interface PasskeyInfo {
  id: string;
  createdAt: string;
  lastUsedAt?: string;
  friendlyName?: string;
}

export type AuthMode = 'login' | 'register';

// Notification history
export interface NotificationRecord {
  id: string;
  title: string;
  body: string;
  url?: string;
  createdAt: string;
  read: boolean;
}

// Telegram notification preferences
export interface NotifyPrefs {
  newExpense: boolean;
  expenseEdited: boolean;
  expenseDeleted: boolean;
  settlementRequest: boolean;
  settlementAccepted: boolean;
  settlementRejected: boolean;
}

export interface TelegramStatus {
  connected: boolean;
  telegramName?: string | null;
  notifyPrefs: NotifyPrefs | null;
}
