const NAME = 'dayriff-trip-clear';
const CLEARED = 'trip-cleared';

/** Broadcasts no trip data: every tab shares the same anonymous browser session. */
export function tripClearChannel(onClear: () => void) {
  if (typeof BroadcastChannel === 'undefined') return {publish() {}, close() {}};
  let channel: BroadcastChannel;
  try {channel = new BroadcastChannel(NAME);}
  catch {return {publish() {}, close() {}};}
  channel.onmessage = event => {if (event.data === CLEARED) onClear();};
  return {publish: () => channel.postMessage(CLEARED), close: () => channel.close()};
}
