import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

import { PHYSICAL_ACQUISITIONS, PHYSICAL_BINDINGS, type PhysicalAcquisition, type PhysicalBinding } from '@bookorbit/types';

import { IsDateKey } from './is-date-key.validator';

@ValidatorConstraint({ name: 'atLeastOnePhysicalIdentifier', async: false })
class AtLeastOneIdentifierConstraint implements ValidatorConstraintInterface {
  validate(_: unknown, args: ValidationArguments): boolean {
    const obj = args.object as CreatePhysicalBookDto;
    return !!(obj.isbn?.trim() || obj.title?.trim());
  }

  defaultMessage(): string {
    return 'At least one of isbn or title must be provided';
  }
}

function AtLeastOneIdentifier(options?: ValidationOptions) {
  return function (constructor: new (...args: unknown[]) => unknown) {
    registerDecorator({
      name: 'atLeastOnePhysicalIdentifier',
      target: constructor,
      propertyName: '',
      options,
      constraints: [],
      validator: AtLeastOneIdentifierConstraint,
    });
  };
}

// Mirrors the bpc_due_requires_lender_chk database constraint so a borrowed copy without a
// lender fails validation with a 400 instead of surfacing the check violation as a 500.
@ValidatorConstraint({ name: 'borrowedRequiresLender', async: false })
export class BorrowedRequiresLenderConstraint implements ValidatorConstraintInterface {
  validate(_: unknown, args: ValidationArguments): boolean {
    const obj = args.object as { acquisition?: PhysicalAcquisition; lender?: string };
    if (!obj.acquisition || obj.acquisition === 'owned') return true;
    return !!obj.lender?.trim();
  }

  defaultMessage(): string {
    return 'lender is required when acquisition is not owned';
  }
}

export function BorrowedRequiresLender(options?: ValidationOptions) {
  return function (constructor: new (...args: unknown[]) => unknown) {
    registerDecorator({
      name: 'borrowedRequiresLender',
      target: constructor,
      propertyName: '',
      options,
      constraints: [],
      validator: BorrowedRequiresLenderConstraint,
    });
  };
}

@AtLeastOneIdentifier()
@BorrowedRequiresLender()
export class CreatePhysicalBookDto {
  @IsInt()
  @Min(1)
  @Type(() => Number)
  libraryId!: number;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  isbn?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  author?: string;

  @IsIn(PHYSICAL_ACQUISITIONS)
  acquisition!: PhysicalAcquisition;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  lender?: string;

  @IsOptional()
  @IsDateKey()
  dueOn?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  pageCount?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  currentPage?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  renewalLimit?: number;

  @IsOptional()
  @IsIn(PHYSICAL_BINDINGS)
  binding?: PhysicalBinding;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  shelfLocation?: string;

  @IsOptional()
  @IsDateKey()
  acquiredOn?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  notes?: string;
}
