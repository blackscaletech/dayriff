export type AppMode = 'sample' | 'live';
export type Budget = 'low' | 'medium' | 'high';
export type DiningStyle = 'fine_dining' | 'high_end';
export type Category = 'food' | 'culture' | 'shop' | 'outdoors';
export interface Coordinates { latitude: number; longitude: number }
export interface Artist { id: string; name: string; detail?: string; image?: PlaceImage }
export interface City { id: string; name: string; region?: string; country?: string; coordinates: Coordinates }
export interface VenueSearchResult { cities: City[]; venues: Venue[] }
export interface Venue { id: string; name: string; city: string; address: string; coordinates: Coordinates; website: string; timezone: string; googlePlaceId?: string; image?: PlaceImage }
export interface StartingLocation { id?: string; name: string; address: string; coordinates: Coordinates; googlePlaceId?: string; source?: Source; approximate?: boolean }
export interface PlanInput {
  artist: Artist;
  venueId: string;
  date: string;
  showTime: string;
  durationMinutes: number;
  startingPoint: string;
  arrivalBy?: string;
  budget?: Budget;
}
export interface Source { title: string; url: string }
export interface PlaceImage {
  url: string; alt: string; attribution?: { name: string; url?: string }[];
}
export interface OpeningHoursDay { day: string; closed: boolean; periods: {opens: string; closes: string}[] }
export interface Place {
  id: string; name: string; category: Category; address: string; coordinates: Coordinates;
  phone?: string; openingHours?: OpeningHoursDay[]; neighborhood?: string;
  description: string; source?: Source; costTier?: 1 | 2 | 3;
  durationMinutes: number; localNote?: string; photoPrompt?: string;
  // Legacy freeform reasons remain readable in saved trips; UI uses grounded place facts instead.
  matchReason?: string; affinity?: number;
  recommendation?: {source: 'qloo_taste' | 'qloo_search'; query?: string};
  diningEvidence?: {fineDining?: true; michelinCollection?: true};
  hoursNote?: string; taxonomy?: string[]; googlePlaceId?: string; image?: PlaceImage; images?: PlaceImage[];
}
export interface Stop extends Place { arrivalTime: string; departureTime: string; arrivalDate: string; departureDate: string; walkMinutes: number; reason?: string; directionsUrl?: string }
export interface Itinerary {
  id: string; mode: AppMode; input: PlanInput; venue: Venue; startingLocation?: StartingLocation; stops: Stop[];
  totalWalkMinutes: number; totalMinutes: number; estimatedArrival: string; estimatedArrivalDate: string;
  routeUrl: string; venueDirectionsUrl?: string; notices: string[]; revision: number;
}
export interface ChatMessage { role: 'user' | 'assistant'; text: string }
export interface PlanHistoryEntry { id: string; label: string; schedule: Pick<PlanInput, 'date' | 'showTime' | 'durationMinutes' | 'arrivalBy'>; stops: Pick<Stop, 'id' | 'name' | 'image'>[]; totalMinutes: number; totalWalkMinutes: number }
export interface PlanResponse { itinerary: Itinerary; message?: string; history?: PlanHistoryEntry[] }
export interface RevisionInput { message: string; replaceStopId?: string }
export interface AppConfig { mode: AppMode; venues: Venue[]; sampleArtists: Artist[]; liveChat: boolean }
export interface ApiError { error: string; code?: string }
