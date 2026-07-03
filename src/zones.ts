export const US_ZONES = [
  "America/New_York",
  "America/Detroit",
  "America/Kentucky/Louisville",
  "America/Chicago",
  "America/Indiana/Indianapolis",
  "America/Denver",
  "America/Phoenix",
  "America/Boise",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu"
] as const;

export type UsZone = (typeof US_ZONES)[number];

export function isAllowedZone(zone: string): zone is UsZone {
  return (US_ZONES as readonly string[]).includes(zone);
}

export function randomZone(rng = Math.random): UsZone {
  const index = Math.min(Math.floor(rng() * US_ZONES.length), US_ZONES.length - 1);
  return US_ZONES[index];
}
