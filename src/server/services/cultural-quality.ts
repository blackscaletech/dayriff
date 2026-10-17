import type { Place } from '../../shared/types.js';

// A conservative, explicit exclusion list, not a claim to know every place's ownership.
// Names are token-boundary matched so e.g. an unrelated “Apple Tree Gallery” survives.
const genericBrands = [
  'starbucks', 'mcdonalds', 'mcdonald s', 'mccafe', 'burger king', 'kfc', 'kentucky fried chicken',
  'subway', 'dunkin', 'dunkin donuts', 'tim hortons', 'costa coffee', 'caffe nero', 'cafe nero',
  'peets coffee', 'peet s coffee', 'blue bottle coffee', 'blank street coffee', 'joe and the juice',
  'pret a manger', 'hard rock cafe', 'wendys', 'wendy s', 'popeyes', 'chick fil a', 'taco bell', 'dominos', 'domino s',
  'pizza hut', 'papa johns', 'papa john s', 'little caesars', 'chipotle', 'five guys', 'shake shack',
  'jollibee', 'panda express', 'panera bread', 'arbys', 'arby s', 'in n out burger', 'carls jr',
  'jack in the box', '7 eleven', '7eleven', 'walgreens', 'cvs', 'duane reade', 'walmart', 'target',
  'tesco', 'sainsburys', 'sainsbury s', 'asda', 'aldi', 'lidl', 'whole foods market', 'trader joes',
  'trader joe s', 'uniqlo', 'h and m', 'zara', 'urban outfitters', 'sephora', 'apple store', 'nike store', 'adidas store',
  'barnes and noble', 'books a million', 'foot locker', 'gap', 'old navy', 'primark', 'best buy', 'dollar general', 'dollar tree',
];
function normalized(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
}
const ambiguousBrands = new Set(['subway', 'target', 'gap', 'aldi', 'lidl', 'asda']);
function genericBrand(name: string): boolean {
  const value = normalized(name);
  return genericBrands.some(brand => value === brand || (!ambiguousBrands.has(brand) && value.startsWith(`${brand} `)));
}
function tags(place: Place): string { return (place.taxonomy ?? []).join(' ').toLowerCase(); }
export function isCulturallyEligible(place: Place): boolean {
  if (genericBrand(place.name)) return false;
  const text = tags(place);
  if (/(?:^|:)convenience_store(?:$|[ :])|(?:^|:)supermarket(?:$|[ :])|(?:^|:)gas_station(?:$|[ :])|(?:^|:)department_store(?:$|[ :])/.test(text)) return false;
  // Booking/operator offices do not supply a drop-in visit, even when tagged tourist_attraction.
  if (/(?:^|:)(?:travel_agency|tour_agency|bus_tour_agency|sightseeing_tour_agency|tour_operator)(?:$|[ :])/.test(text)) return false;
  // An art school or private service is not a drop-in attraction without explicit visitor evidence.
  const visitorEvidence = /museum|gallery|tourist_attraction|cultural_center|historical|landmark/.test(text);
  return visitorEvidence || !/(?:^|:)(?:college|school|art_school|tattoo_shop|gym|medical_clinic|ferry_terminal)(?:$|[ :])/.test(text);
}
/** Evidence-based preference, not a fabricated cultural-significance certification. */
export function culturalQuality(place: Place): number {
  const text = tags(place);
  if (/bookstore|book_store|book_shop|record_store|vinyl|museum|art_gallery|cultural|historic|heritage|performing_art|jazz_club|independent_cinema/.test(text)) return 1;
  if (/gallery|theat(?:er|re)|monument|botanical|garden|specialty|antique|craft|market|music_venue/.test(text)) return .85;
  if (place.category === 'outdoors') return .7;
  if (/sculpture|landmark|place_of_worship/.test(text)) return .75;
  // Tourism alone is not evidence of heritage, art or another cultural focus.
  if (/tourist_attraction/.test(text)) return .4;
  if (place.category === 'shop' && /retail|shopping|jeweler/.test(text)) return .5;
  if (/fast_food/.test(text)) return .2;
  return place.category === 'food' ? .35 : .25;
}
export function selectCulturalPlaces(places: Place[]): Place[] {
  return places.filter(isCulturallyEligible).sort((a, b) => culturalQuality(b) - culturalQuality(a) || (b.affinity ?? 0) - (a.affinity ?? 0));
}
