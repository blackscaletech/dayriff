import type {ShareLink} from '../shared/sharing';

export interface SharingNavigator {share?: (data: ShareData) => Promise<void>; canShare?: (data?: ShareData) => boolean; clipboard?: {writeText: (text: string) => Promise<void>}};
/** Accept only our unguessable same-origin share path, never provider/user-supplied URLs. */
export function tripShareUrl(link: ShareLink, origin: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(link.shareId) || link.path !== `/shared/${link.shareId}` || !Number.isFinite(Date.parse(link.expiresAt))) throw new Error('The shared link could not be prepared.');
  return new URL(link.path, origin).href;
}
export function nativeShareAvailable(navigation: SharingNavigator, data: ShareData): boolean {
  try {return typeof navigation.share === 'function' && (typeof navigation.canShare !== 'function' || navigation.canShare(data));} catch {return false;}
}
export async function shareTrip(navigation: SharingNavigator, data: ShareData): Promise<'opened' | 'cancelled' | 'unavailable'> {
  if (!nativeShareAvailable(navigation, data) || !navigation.share) return 'unavailable';
  try {await navigation.share(data); return 'opened';}
  catch (error) {return error && typeof error === 'object' && 'name' in error && error.name === 'AbortError' ? 'cancelled' : 'unavailable';}
}
export async function copyTripLink(navigation: SharingNavigator, url: string): Promise<boolean> {
  if (typeof navigation.clipboard?.writeText !== 'function') return false;
  try {await navigation.clipboard.writeText(url); return true;} catch {return false;}
}
