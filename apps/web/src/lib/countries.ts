/** Countries offered for nationality and passport issuing country (ISO 3166-1 alpha-2). */
export const COUNTRIES: { code: string; name: string }[] = [
  { code: 'PK', name: 'Pakistan' }, { code: 'SA', name: 'Saudi Arabia' }, { code: 'AE', name: 'United Arab Emirates' },
  { code: 'GB', name: 'United Kingdom' }, { code: 'US', name: 'United States' }, { code: 'CA', name: 'Canada' },
  { code: 'AU', name: 'Australia' }, { code: 'IN', name: 'India' }, { code: 'BD', name: 'Bangladesh' },
  { code: 'AF', name: 'Afghanistan' }, { code: 'AZ', name: 'Azerbaijan' }, { code: 'BH', name: 'Bahrain' },
  { code: 'BN', name: 'Brunei' }, { code: 'DE', name: 'Germany' }, { code: 'EG', name: 'Egypt' },
  { code: 'FR', name: 'France' }, { code: 'ID', name: 'Indonesia' }, { code: 'IQ', name: 'Iraq' },
  { code: 'IR', name: 'Iran' }, { code: 'JO', name: 'Jordan' }, { code: 'KW', name: 'Kuwait' },
  { code: 'LB', name: 'Lebanon' }, { code: 'MY', name: 'Malaysia' }, { code: 'MA', name: 'Morocco' },
  { code: 'NG', name: 'Nigeria' }, { code: 'NO', name: 'Norway' }, { code: 'OM', name: 'Oman' },
  { code: 'QA', name: 'Qatar' }, { code: 'SG', name: 'Singapore' }, { code: 'ZA', name: 'South Africa' },
  { code: 'LK', name: 'Sri Lanka' }, { code: 'SE', name: 'Sweden' }, { code: 'TR', name: 'Türkiye' },
];
export const countryName = (code: string | null | undefined): string => COUNTRIES.find((c) => c.code === code)?.name ?? code ?? '';
