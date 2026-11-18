// The person's time zone as Outlook names it (fix 0.26.1, docs/build/step-fix-0.26.1.md). Microsoft
// Graph takes an event's start and end as a wall time plus a time zone. Meetings made by
// Pobots showed "(UTC)" in Outlook because the engine sent UTC; Outlook shows no zone when an event
// is in the person's own zone. Graph takes Windows zone names ("W. Europe Standard Time") and a short
// list of IANA names (https://learn.microsoft.com/en-us/graph/api/resources/datetimetimezone), and
// that list lacks Europe/Stockholm. So the engine's IANA zone is mapped to its Windows name, from
// CLDR's windowsZones.xml (the same table Windows and ICU use). A zone not in the table goes as one
// of Graph's own IANA names when it is one, and otherwise as UTC, the way it went before.

const WINDOWS: Record<string, string[]> = {
  "W. Europe Standard Time": ["Europe/Stockholm", "Europe/Oslo", "Europe/Berlin", "Europe/Amsterdam", "Europe/Vienna", "Europe/Zurich", "Europe/Rome", "Europe/Luxembourg", "Europe/Malta", "Europe/Monaco", "Europe/Andorra", "Europe/Gibraltar", "Europe/Vaduz", "Europe/San_Marino", "Europe/Vatican", "Europe/Busingen", "Arctic/Longyearbyen"],
  "Romance Standard Time": ["Europe/Paris", "Europe/Brussels", "Europe/Copenhagen", "Europe/Madrid", "Africa/Ceuta"],
  "Central Europe Standard Time": ["Europe/Budapest", "Europe/Prague", "Europe/Bratislava", "Europe/Belgrade", "Europe/Ljubljana", "Europe/Podgorica", "Europe/Tirane"],
  "Central European Standard Time": ["Europe/Warsaw", "Europe/Zagreb", "Europe/Sarajevo", "Europe/Skopje"],
  "GMT Standard Time": ["Europe/London", "Europe/Dublin", "Europe/Lisbon", "Europe/Guernsey", "Europe/Isle_of_Man", "Europe/Jersey", "Atlantic/Canary", "Atlantic/Faroe", "Atlantic/Madeira"],
  "Greenwich Standard Time": ["Atlantic/Reykjavik"],
  "FLE Standard Time": ["Europe/Helsinki", "Europe/Tallinn", "Europe/Riga", "Europe/Vilnius", "Europe/Kiev", "Europe/Kyiv", "Europe/Sofia", "Europe/Mariehamn"],
  "GTB Standard Time": ["Europe/Athens", "Europe/Bucharest", "Asia/Nicosia", "Asia/Famagusta"],
  "Turkey Standard Time": ["Europe/Istanbul"],
  "Kaliningrad Standard Time": ["Europe/Kaliningrad"],
  "Russian Standard Time": ["Europe/Moscow", "Europe/Simferopol", "Europe/Kirov"],
  UTC: ["UTC", "Etc/UTC", "Etc/GMT", "GMT"],
  "Eastern Standard Time": ["America/New_York", "America/Detroit", "America/Toronto", "America/Nassau"],
  "Central Standard Time": ["America/Chicago", "America/Winnipeg"],
  "Mountain Standard Time": ["America/Denver", "America/Edmonton", "America/Boise"],
  "US Mountain Standard Time": ["America/Phoenix"],
  "Pacific Standard Time": ["America/Los_Angeles", "America/Vancouver"],
  "Alaskan Standard Time": ["America/Anchorage"],
  "Hawaiian Standard Time": ["Pacific/Honolulu"],
  "E. South America Standard Time": ["America/Sao_Paulo"],
  "India Standard Time": ["Asia/Kolkata", "Asia/Calcutta"],
  "China Standard Time": ["Asia/Shanghai", "Asia/Hong_Kong", "Asia/Macau"],
  "Singapore Standard Time": ["Asia/Singapore", "Asia/Kuala_Lumpur", "Asia/Manila"],
  "Tokyo Standard Time": ["Asia/Tokyo"],
  "Korea Standard Time": ["Asia/Seoul"],
  "Arabian Standard Time": ["Asia/Dubai", "Asia/Muscat"],
  "AUS Eastern Standard Time": ["Australia/Sydney", "Australia/Melbourne"],
  "New Zealand Standard Time": ["Pacific/Auckland"],
};

const BY_IANA = new Map(Object.entries(WINDOWS).flatMap(([win, zones]) => zones.map((z) => [z, win] as const)));

/** Graph's own list of IANA names it takes besides the Windows names (the "Additional time zones"). */
const GRAPH_IANA = new Set(
  "Etc/GMT+12 Etc/GMT+11 Pacific/Honolulu America/Anchorage America/Santa_Isabel America/Los_Angeles America/Phoenix America/Chihuahua America/Denver America/Guatemala America/Chicago America/Mexico_City America/Regina America/Bogota America/New_York America/Indiana/Indianapolis America/Caracas America/Asuncion America/Halifax America/Cuiaba America/La_Paz America/Santiago America/St_Johns America/Sao_Paulo America/Argentina/Buenos_Aires America/Cayenne America/Godthab America/Montevideo America/Bahia Etc/GMT+2 Atlantic/Azores Atlantic/Cape_Verde Africa/Casablanca Etc/GMT Europe/London Atlantic/Reykjavik Europe/Berlin Europe/Budapest Europe/Paris Europe/Warsaw Africa/Lagos Africa/Windhoek Europe/Bucharest Asia/Beirut Africa/Cairo Asia/Damascus Africa/Johannesburg Europe/Kyiv Europe/Istanbul Asia/Jerusalem Asia/Amman Asia/Baghdad Europe/Kaliningrad Asia/Riyadh Africa/Nairobi Asia/Tehran Asia/Dubai Asia/Baku Europe/Moscow Indian/Mauritius Asia/Tbilisi Asia/Yerevan Asia/Kabul Asia/Karachi Asia/Kolkata Asia/Colombo Asia/Kathmandu Asia/Dhaka Asia/Yekaterinburg Asia/Bangkok Asia/Novosibirsk Asia/Shanghai Asia/Krasnoyarsk Asia/Singapore Australia/Perth Asia/Taipei Asia/Ulaanbaatar Asia/Irkutsk Asia/Tokyo Asia/Seoul Australia/Adelaide Australia/Darwin Australia/Brisbane Australia/Sydney Pacific/Port_Moresby Australia/Hobart Asia/Yakutsk Pacific/Guadalcanal Asia/Vladivostok Pacific/Auckland Etc/GMT-12 Pacific/Fiji Asia/Magadan Pacific/Tongatapu Pacific/Apia Pacific/Kiritimati".split(" "),
);

/** The name Graph takes for the IANA zone `tz`: its Windows name, Graph's own IANA name, or undefined. */
export function graphZone(tz: string): string | undefined {
  return BY_IANA.get(tz) ?? (GRAPH_IANA.has(tz) ? tz : undefined);
}
