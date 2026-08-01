/**
 * Da codice IATA a nome leggibile.
 *
 * "MXP" e "BGY" dicono qualcosa solo a chi vola spesso: in una notifica che si
 * legge in tre secondi al semaforo, il nome della città è l'unica forma
 * utilizzabile. Gli aeroporti italiani — quelli da cui si parte — diventano
 * quindi la città stessa.
 *
 * Due forme, perché servono in due posti con vincoli diversi:
 *  - `airportCity`  → nome corto, per le colonne strette delle tabelle;
 *  - `airportLabel` → nome completo, quando la città ha più scali e "Milano"
 *    da solo sarebbe ambiguo (Malpensa e Linate non sono intercambiabili:
 *    cambiano il modo di arrivarci e il tempo che serve).
 *
 * Un codice sconosciuto resta il codice: meglio tre lettere oneste di un nome
 * inventato o di uno spazio vuoto.
 */

/** @type {Record<string, { city: string, label?: string }>} */
const AIRPORTS = {
  // --- Italia: partenze -----------------------------------------------------
  TRN: { city: 'Torino' },
  MXP: { city: 'Milano', label: 'Milano Malpensa' },
  LIN: { city: 'Milano', label: 'Milano Linate' },
  BGY: { city: 'Bergamo', label: 'Bergamo Orio' },
  VCE: { city: 'Venezia' },
  TSF: { city: 'Treviso' },
  BLQ: { city: 'Bologna' },
  FCO: { city: 'Roma', label: 'Roma Fiumicino' },
  CIA: { city: 'Roma', label: 'Roma Ciampino' },
  NAP: { city: 'Napoli' },
  BRI: { city: 'Bari' },
  BDS: { city: 'Brindisi' },
  CTA: { city: 'Catania' },
  PMO: { city: 'Palermo' },
  TPS: { city: 'Trapani' },
  CAG: { city: 'Cagliari' },
  OLB: { city: 'Olbia' },
  AHO: { city: 'Alghero' },
  GOA: { city: 'Genova' },
  VRN: { city: 'Verona' },
  PSA: { city: 'Pisa' },
  FLR: { city: 'Firenze' },
  TRS: { city: 'Trieste' },
  AOI: { city: 'Ancona' },
  PSR: { city: 'Pescara' },
  SUF: { city: 'Lamezia' },
  REG: { city: 'Reggio Calabria' },
  RMI: { city: 'Rimini' },
  PMF: { city: 'Parma' },
  VBS: { city: 'Brescia' },
  CUF: { city: 'Cuneo' },

  // --- Destinazioni monitorate ---------------------------------------------
  DEL: { city: 'Delhi' },
  BOM: { city: 'Mumbai' },
  BLR: { city: 'Bangalore' },
  MAA: { city: 'Chennai' },
  CCU: { city: 'Calcutta' },
  CGK: { city: 'Giacarta' },
  DPS: { city: 'Bali' },
  SUB: { city: 'Surabaya' },
  BKK: { city: 'Bangkok' },
  DMK: { city: 'Bangkok', label: 'Bangkok Don Mueang' },
  HKT: { city: 'Phuket' },
  SGN: { city: 'Ho Chi Minh' },
  HAN: { city: 'Hanoi' },
  DAD: { city: 'Da Nang' },
  PNH: { city: 'Phnom Penh' },
  REP: { city: 'Siem Reap' },
  KUL: { city: 'Kuala Lumpur' },
  SIN: { city: 'Singapore' },
  CMB: { city: 'Colombo' },
  MNL: { city: 'Manila' },
  KTM: { city: 'Kathmandu' },
  RGN: { city: 'Yangon' },
  VTE: { city: 'Vientiane' },

  // --- Scali ricorrenti sulle rotte per l'Asia ------------------------------
  DOH: { city: 'Doha' },
  MCT: { city: 'Muscat' },
  SLL: { city: 'Salalah' },
  DXB: { city: 'Dubai' },
  AUH: { city: 'Abu Dhabi' },
  SHJ: { city: 'Sharjah' },
  KWI: { city: 'Kuwait' },
  BAH: { city: 'Bahrain' },
  RUH: { city: 'Riyadh' },
  JED: { city: 'Jeddah' },
  IST: { city: 'Istanbul' },
  SAW: { city: 'Istanbul', label: 'Istanbul Sabiha' },
  CAI: { city: 'Il Cairo' },
  ADD: { city: 'Addis Abeba' },
  TLV: { city: 'Tel Aviv' },
  AMM: { city: 'Amman' },
  BAK: { city: 'Baku' },
  GYD: { city: 'Baku' },
  TAS: { city: 'Tashkent' },
  ALA: { city: 'Almaty' },
  SVO: { city: 'Mosca' },
  HKG: { city: 'Hong Kong' },
  ICN: { city: 'Seoul' },
  NRT: { city: 'Tokyo', label: 'Tokyo Narita' },
  HND: { city: 'Tokyo', label: 'Tokyo Haneda' },
  PVG: { city: 'Shanghai' },
  PEK: { city: 'Pechino' },
  PKX: { city: 'Pechino', label: 'Pechino Daxing' },
  CAN: { city: 'Canton' },
  TPE: { city: 'Taipei' },
  KMG: { city: 'Kunming' },

  // --- Scali europei --------------------------------------------------------
  AMS: { city: 'Amsterdam' },
  CDG: { city: 'Parigi', label: 'Parigi CDG' },
  ORY: { city: 'Parigi', label: 'Parigi Orly' },
  FRA: { city: 'Francoforte' },
  MUC: { city: 'Monaco' },
  ZRH: { city: 'Zurigo' },
  GVA: { city: 'Ginevra' },
  VIE: { city: 'Vienna' },
  LHR: { city: 'Londra', label: 'Londra Heathrow' },
  LGW: { city: 'Londra', label: 'Londra Gatwick' },
  STN: { city: 'Londra', label: 'Londra Stansted' },
  MAD: { city: 'Madrid' },
  BCN: { city: 'Barcellona' },
  LIS: { city: 'Lisbona' },
  BRU: { city: 'Bruxelles' },
  CPH: { city: 'Copenaghen' },
  ARN: { city: 'Stoccolma' },
  OSL: { city: 'Oslo' },
  HEL: { city: 'Helsinki' },
  WAW: { city: 'Varsavia' },
  PRG: { city: 'Praga' },
  BUD: { city: 'Budapest' },
  OTP: { city: 'Bucarest' },
  ATH: { city: 'Atene' },
  BEG: { city: 'Belgrado' },
};

/** Nome corto (città), per le colonne strette. @param {string} code */
export function airportCity(code) {
  const key = String(code ?? '').trim().toUpperCase();
  return AIRPORTS[key]?.city ?? key;
}

/** Nome esteso, con lo scalo quando la città ne ha più di uno. @param {string} code */
export function airportLabel(code) {
  const key = String(code ?? '').trim().toUpperCase();
  const entry = AIRPORTS[key];
  if (!entry) return key;
  return entry.label ?? entry.city;
}

/** Elenco leggibile di aeroporti: "Torino, Milano Malpensa, Bergamo Orio". */
export function airportListLabel(codes) {
  return (Array.isArray(codes) ? codes : []).map(airportLabel).join(', ');
}
