import { registerDecorator, ValidationOptions, ValidatorConstraint, ValidatorConstraintInterface } from 'class-validator';

import { isDateKey } from '../../../common/utils/timezone.utils';

// dueOn / acquiredOn / returnedOn are `date(mode: 'string')` columns, so they must be calendar
// day keys. A full ISO timestamp would carry an implicit UTC instant and shift the day for
// users west of UTC.
@ValidatorConstraint({ name: 'isDateKey', async: false })
export class IsDateKeyConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value === 'string' && isDateKey(value);
  }

  defaultMessage(): string {
    return 'must be a calendar date in YYYY-MM-DD form';
  }
}

export function IsDateKey(options?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isDateKey',
      target: object.constructor,
      propertyName,
      options,
      constraints: [],
      validator: IsDateKeyConstraint,
    });
  };
}
