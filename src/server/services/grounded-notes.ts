import type { Place } from '../../shared/types.js';

export interface GroundedStopNote { id: string; note: string; evidence_quote: string }

const filler = new Set(`a an the and or of to in on at by for from with as is are was were be been being it its this that these those there their has have had can you your here also into about offers offer featuring feature features includes include known browse visit discover see look collection collections focus spanning alongside sit sits`.split(' '));
const generic = new Set(`place places stop stops nearby local popular recommended recommendation recommendations qloo found concert venue cultural culture city destination experience great good unique distinctive interesting located location situated visit visiting explore exploring enjoy discover discovering area attraction attractions spot spots`.split(' '));
const numberWords = new Set(`zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred thousand million first second third fourth fifth sixth seventh eighth ninth tenth oldest newest`.split(' '));
// These claims affect visitor behavior or imply history, status, ownership or safety.
// Require their actual vocabulary in the quoted evidence rather than trusting overlap alone.
const consequential = /^(?:must|required?|requirement|prohibit|forbid|forbidden|ban|allow|permit|permission|respect|consent|remove|shoe|dress|sacred|holy|ritual|religio|worship|photograph|photo|flash|rule|founded?|establish|opened?|since|built|designed?|dedicat|historic|heritage|origin|memorial|commemorat|century|battle|slavery|enslaved?|colonial|indigenous|royal|unesco|independent|family|owned?|ownership|endors|free|ticket|fee|admission|accessible|accessibility|wheelchair|vegan|allerg|gluten|kosher|halal|safe|safety|quiet|silent)/;
const negations = new Set(['no', 'not', 'never', 'without', 'cannot', 'dont', 'prohibited', 'forbidden']);

function normalized(value: string): string {
  return value.normalize('NFKC').replace(/[\u2018\u2019]/g, "'").replace(/[\u2010-\u2015]/g, '-').replace(/\s+/gu, ' ').trim().toLowerCase();
}
function words(value: string): string[] {
  return normalized(value).match(/[\p{L}\p{N}]+(?:'[\p{L}]+)?/gu) ?? [];
}
function stem(word: string): string {
  return word.length > 5 ? word.replace(/(?:ing|ed|es|s)$/, '') : word.length > 3 ? word.replace(/s$/, '') : word;
}
function substantiveDescription(place: Place): boolean {
  const description = normalized(place.description);
  if (description.length < 35 || /^(?:a |an |the )?(?:nearby |local )?(?:place|stop) (?:found|recommended|selected|matched)\b/.test(description)) return false;
  const nameWords = new Set(words(place.name));
  const details = words(description).filter(word => word.length > 2 && !filler.has(word) && !generic.has(word) && !nameWords.has(word));
  return new Set(details).size >= 4;
}
function validNote(place: Place, proposed: GroundedStopNote): string | undefined {
  const note = proposed.note.replace(/\s+/gu, ' ').trim();
  const quote = normalized(proposed.evidence_quote);
  if (!substantiveDescription(place) || note.length < 20 || note.length > 220 || /[<>\u0000-\u001f]/u.test(note)) return;
  if (quote.length < 20 || !normalized(place.description).includes(quote)) return;
  const noteWords = words(note);
  const evidenceWords = words(quote);
  const lexicalNote = noteWords.join(' ');
  // A local note should add a short perspective, not repeat the description verbatim.
  if (words(place.description).join(' ').includes(lexicalNote) || evidenceWords.join(' ').includes(lexicalNote)) return;
  const evidence = new Set(evidenceWords.map(stem));
  const supported = new Set([...evidence, ...words(place.name).map(stem)]);
  const meaningful = noteWords.filter(word => !filler.has(word) && word.length > 1);
  if (meaningful.length < 2 || meaningful.filter(word => evidence.has(stem(word))).length / meaningful.length < .7) return;
  for (const word of noteWords) {
    if ((/\d/u.test(word) || numberWords.has(word) || negations.has(word) || consequential.test(stem(word))) && !evidence.has(stem(word))) return;
  }
  // Proper names must come from this place's name or quoted description, including
  // sentence-initial names; harmless sentence starters are covered by filler words.
  const capitals = note.match(/\b\p{Lu}[\p{L}\p{M}'’-]+/gu) ?? [];
  if (capitals.some(word => !filler.has(normalized(word)) && !supported.has(stem(normalized(word))))) return;
  return note;
}

/** Conservative evidence checks; invalid model notes never become generic fallbacks. */
export function applyGroundedNotes(places: Place[], notes: GroundedStopNote[]): Place[] {
  const proposed = new Map<string, GroundedStopNote[]>();
  for (const note of notes) {
    const list = proposed.get(note.id) ?? [];
    list.push(note);
    proposed.set(note.id, list);
  }
  return places.map(place => {
    for (const note of proposed.get(place.id) ?? []) {
      const localNote = validNote(place, note);
      if (localNote) return {...place, localNote};
    }
    return place;
  });
}
