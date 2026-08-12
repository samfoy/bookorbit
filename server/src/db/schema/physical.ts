import { sql } from 'drizzle-orm';
import { check, date, index, integer, pgTable, primaryKey, text, timestamp, varchar } from 'drizzle-orm/pg-core';
import type { PhysicalAcquisition, PhysicalBinding } from '@bookorbit/types';

import { books } from './books';
import { users } from './auth';

export const bookPhysicalCopies = pgTable(
  'book_physical_copies',
  {
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    bookId: integer('book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    acquisition: varchar('acquisition', { length: 20 }).$type<PhysicalAcquisition>().notNull().default('owned'),
    // Copy-specific: a reprint rarely matches the page count of the matched edition,
    // so this overrides book_metadata.pageCount when present.
    pageCount: integer('page_count'),
    currentPage: integer('current_page').notNull().default(0),
    lender: varchar('lender', { length: 255 }),
    dueOn: date('due_on', { mode: 'string' }),
    renewalsUsed: integer('renewals_used').notNull().default(0),
    renewalLimit: integer('renewal_limit'),
    returnedOn: date('returned_on', { mode: 'string' }),
    binding: varchar('binding', { length: 20 }).$type<PhysicalBinding>(),
    shelfLocation: varchar('shelf_location', { length: 255 }),
    acquiredOn: date('acquired_on', { mode: 'string' }),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.bookId], name: 'book_physical_copies_pkey' }),
    index('bpc_book_id_idx').on(t.bookId),
    // Partial: the due-soon widget only ever reads active loans.
    index('bpc_user_due_on_idx')
      .on(t.userId, t.dueOn)
      .where(sql`${t.dueOn} is not null and ${t.returnedOn} is null`),
    check('bpc_acquisition_chk', sql`${t.acquisition} in ('owned', 'borrowed_library', 'borrowed_personal')`),
    check('bpc_binding_chk', sql`${t.binding} is null or ${t.binding} in ('hardcover', 'paperback', 'mass_market', 'other')`),
    check('bpc_current_page_nonnegative_chk', sql`${t.currentPage} >= 0`),
    check('bpc_page_count_positive_chk', sql`${t.pageCount} is null or ${t.pageCount} > 0`),
    check('bpc_renewals_used_nonnegative_chk', sql`${t.renewalsUsed} >= 0`),
    check('bpc_due_requires_lender_chk', sql`${t.acquisition} = 'owned' or ${t.lender} is not null`),
  ],
);

export type BookPhysicalCopy = typeof bookPhysicalCopies.$inferSelect;
export type NewBookPhysicalCopy = typeof bookPhysicalCopies.$inferInsert;
