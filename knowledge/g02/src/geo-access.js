const COUNTRY_CODE = /^[A-Z]{2}$/;

export function parseAllowedCountries(value) {
  if (!value?.trim()) return new Set();
  const countries = value.split(',').map((country) => country.trim().toUpperCase()).filter(Boolean);
  const invalid = countries.find((country) => !COUNTRY_CODE.test(country));
  if (invalid) throw new Error(`Invalid country code in AUTH_ALLOWED_COUNTRIES: ${invalid}`);
  return new Set(countries);
}

export function countryFromRequest(request, headerName) {
  const value = request.headers[headerName.toLowerCase()];
  const country = (Array.isArray(value) ? value[0] : value)?.trim().toUpperCase();
  return country && COUNTRY_CODE.test(country) ? country : null;
}

export function geoAccess(request, allowedCountries, headerName) {
  if (allowedCountries.size === 0) return { allowed: true, country: null };
  const country = countryFromRequest(request, headerName);
  return { allowed: country !== null && allowedCountries.has(country), country };
}
