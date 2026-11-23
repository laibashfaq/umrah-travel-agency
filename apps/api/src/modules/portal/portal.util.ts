import { ForbiddenException } from '@nestjs/common';
import type { TravelerDto } from '@umrah/shared';
import type { AuthUser } from '../../auth/auth.types';
import { FieldEncryption } from '../../common/crypto/field-encryption';
import type { Traveler } from '../../generated/prisma/client';

/** The customer record behind a signed-in customer. It is created when the email is verified. */
export function requireCustomerId(user: AuthUser): string {
  if (!user.customerId) {
    throw new ForbiddenException({ message: 'Please verify your email address first.', code: 'email_unverified' });
  }
  return user.customerId;
}

export const ymd = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null);
export const asDate = (s: string | undefined | null): Date | null => (s ? new Date(`${s}T00:00:00.000Z`) : null);

export function travelerToDto(t: Traveler, enc: FieldEncryption): TravelerDto {
  const mask = (cipher: string | null) => (cipher ? FieldEncryption.mask(enc.decrypt(cipher)) : null);
  return {
    id: t.id,
    relationship: t.relationship,
    title: t.title,
    firstName: t.firstName,
    middleName: t.middleName,
    lastName: t.lastName,
    fatherOrHusbandName: t.fatherOrHusbandName,
    gender: t.gender,
    dateOfBirth: ymd(t.dateOfBirth) as string,
    placeOfBirth: t.placeOfBirth,
    nationality: t.nationality,
    passportNumberMasked: mask(t.passportNumberEnc),
    passportIssuingCountry: t.passportIssuingCountry,
    passportIssueDate: ymd(t.passportIssueDate),
    passportExpiryDate: ymd(t.passportExpiryDate),
    nationalIdMasked: mask(t.nationalIdEnc),
    phone: t.phone,
    email: t.email,
    mahramTravelerId: t.mahramTravelerId,
    mahramRelationship: t.mahramRelationship,
    specialRequirements: t.specialRequirements,
  };
}

export const fullName = (t: { firstName: string; middleName: string | null; lastName: string }): string =>
  [t.firstName, t.middleName, t.lastName].filter(Boolean).join(' ');
