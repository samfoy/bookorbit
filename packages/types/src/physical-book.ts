export const PHYSICAL_ACQUISITIONS = ["owned", "borrowed_library", "borrowed_personal"] as const;
export type PhysicalAcquisition = (typeof PHYSICAL_ACQUISITIONS)[number];

export const PHYSICAL_BINDINGS = ["hardcover", "paperback", "mass_market", "other"] as const;
export type PhysicalBinding = (typeof PHYSICAL_BINDINGS)[number];

// Ordered most to least pressing; the UI maps each to its own theme token.
export const LOAN_URGENCIES = ["overdue", "urgent", "tight", "comfortable"] as const;
export type LoanUrgency = (typeof LOAN_URGENCIES)[number];

export type PhysicalCopy = {
  bookId: number;
  acquisition: PhysicalAcquisition;
  pageCount: number | null;
  currentPage: number;
  lender: string | null;
  dueOn: string | null;
  renewalsUsed: number;
  renewalLimit: number | null;
  returnedOn: string | null;
  binding: PhysicalBinding | null;
  shelfLocation: string | null;
  acquiredOn: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
};

// Always derived at read time, never stored: page counts and due dates change, and a
// stored percentage would drift out of sync with the copy row.
export type PhysicalCopyDerived = {
  effectivePageCount: number | null;
  percentage: number | null;
  pagesRemaining: number | null;
  daysRemaining: number | null;
  pagesPerDayNeeded: number | null;
  paceLast7Days: number;
  onTrack: boolean | null;
  urgency: LoanUrgency | null;
};

export type PhysicalCopySummary = PhysicalCopy & PhysicalCopyDerived;

export const DUE_SOON_LIMIT = 10;

export type DueSoonWidgetData = {
  entries: DueSoonEntry[];
};

export type DueSoonEntry = {
  bookId: number;
  title: string;
  authorName: string | null;
  coverUrl: string | null;
  acquisition: PhysicalAcquisition;
  lender: string | null;
  dueOn: string;
  daysRemaining: number;
  pagesRemaining: number | null;
  pagesPerDayNeeded: number | null;
  paceLast7Days: number;
  onTrack: boolean | null;
  urgency: LoanUrgency;
};
