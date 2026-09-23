export interface MusicLicense {
  readonly spdx: "CC-BY-4.0";
  readonly name: "Creative Commons Attribution 4.0 International";
  readonly url: string;
  readonly attribution: string;
}

export interface MusicTrack {
  readonly id: string;
  readonly title: string;
  readonly artist: string;
  readonly description: string;
  readonly genres: readonly string[];
  readonly moods: readonly string[];
  readonly durationSeconds: number;
  readonly bpm: number | null;
  readonly isrc: string;
  readonly assetUrl: string;
  readonly sourceUrl: string;
  readonly license: MusicLicense;
}

const LICENSE_URL = "https://creativecommons.org/licenses/by/4.0/";
const ARTIST = "Kevin MacLeod";

/**
 * Curated remote tracks with source and license metadata from each linked track page.
 * Asset URLs are streamed for preview; the catalog does not download or bundle audio.
 */
export const MUSIC_CATALOG = [
  {
    id: "carefree",
    title: "Carefree",
    artist: ARTIST,
    description: "Bright ukulele, guitar, marimba, and percussion for upbeat scenes.",
    genres: ["contemporary", "acoustic"],
    moods: ["bouncy", "bright", "calming", "uplifting"],
    durationSeconds: 205,
    bpm: 96,
    isrc: "USUAN1400037",
    assetUrl: "https://incompetech.com/music/royalty-free/mp3-royaltyfree/Carefree.mp3",
    sourceUrl: "https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1400037",
    license: {
      spdx: "CC-BY-4.0",
      name: "Creative Commons Attribution 4.0 International",
      url: LICENSE_URL,
      attribution: "Carefree by Kevin MacLeod (incompetech.com), licensed under CC BY 4.0.",
    },
  },
  {
    id: "sincerely",
    title: "Sincerely",
    artist: ARTIST,
    description: "Relaxed synth and percussion with a reflective, hopeful feel.",
    genres: ["contemporary", "electronic"],
    moods: ["calm", "grooving", "relaxed", "reflective"],
    durationSeconds: 375,
    bpm: 72,
    isrc: "USUAN1900016",
    assetUrl: "https://incompetech.com/music/royalty-free/mp3-royaltyfree/Sincerely.mp3",
    sourceUrl: "https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1900016",
    license: {
      spdx: "CC-BY-4.0",
      name: "Creative Commons Attribution 4.0 International",
      url: LICENSE_URL,
      attribution: "Sincerely by Kevin MacLeod (incompetech.com), licensed under CC BY 4.0.",
    },
  },
  {
    id: "eternity",
    title: "Eternity",
    artist: ARTIST,
    description: "Polished guitar, bass, drums, electric piano, and synth groove.",
    genres: ["electronica", "latin"],
    moods: ["relaxed", "grooving", "polished"],
    durationSeconds: 198,
    bpm: 100,
    isrc: "USUAN1600031",
    assetUrl: "https://incompetech.com/music/royalty-free/mp3-royaltyfree/Eternity.mp3",
    sourceUrl: "https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1600031",
    license: {
      spdx: "CC-BY-4.0",
      name: "Creative Commons Attribution 4.0 International",
      url: LICENSE_URL,
      attribution: "Eternity by Kevin MacLeod (incompetech.com), licensed under CC BY 4.0.",
    },
  },
  {
    id: "clear-air",
    title: "Clear Air",
    artist: ARTIST,
    description: "Easygoing acoustic and classical guitar with soft piano.",
    genres: ["pop", "acoustic"],
    moods: ["bright", "calming", "relaxed"],
    durationSeconds: 183,
    bpm: 68,
    isrc: "USUAN1100626",
    assetUrl: "https://incompetech.com/music/royalty-free/mp3-royaltyfree/Clear%20Air.mp3",
    sourceUrl: "https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1100626",
    license: {
      spdx: "CC-BY-4.0",
      name: "Creative Commons Attribution 4.0 International",
      url: LICENSE_URL,
      attribution: "Clear Air by Kevin MacLeod (incompetech.com), licensed under CC BY 4.0.",
    },
  },
] as const satisfies readonly MusicTrack[];

export interface MusicCatalogFilter {
  genre?: string;
  mood?: string;
  limit?: number;
}

export function listMusicTracks(filter: MusicCatalogFilter = {}): MusicTrack[] {
  const genre = normalize(filter.genre ?? "");
  const mood = normalize(filter.mood ?? "");
  const limit = normalizeLimit(filter.limit);
  return MUSIC_CATALOG
    .filter((track) => !genre || track.genres.some((value) => normalize(value) === genre))
    .filter((track) => !mood || track.moods.some((value) => normalize(value) === mood))
    .slice(0, limit);
}

export function searchMusicTracks(query: string, filter: MusicCatalogFilter = {}): MusicTrack[] {
  const terms = normalize(query).split(" ").filter(Boolean);
  if (terms.length === 0) return listMusicTracks(filter);
  const { limit: _limit, ...unlimitedFilter } = filter;
  return listMusicTracks(unlimitedFilter)
    .map((track) => ({ track, score: scoreTrack(track, terms) }))
    .filter((result) => result.score > 0)
    .sort((left, right) => right.score - left.score || left.track.title.localeCompare(right.track.title))
    .slice(0, normalizeLimit(filter.limit))
    .map(({ track }) => track);
}

export function findMusicTrack(reference: string): MusicTrack | null {
  const query = normalize(reference);
  if (!query) return null;
  return MUSIC_CATALOG.find((track) => normalize(track.id) === query || normalize(track.title) === query) ?? null;
}

export function listMusicGenres(): string[] {
  return uniqueSorted(MUSIC_CATALOG.flatMap((track) => track.genres));
}

export function listMusicMoods(): string[] {
  return uniqueSorted(MUSIC_CATALOG.flatMap((track) => track.moods));
}

function scoreTrack(track: MusicTrack, terms: string[]): number {
  const id = normalize(track.id);
  const title = normalize(track.title);
  const artist = normalize(track.artist);
  const genres = track.genres.map(normalize);
  const moods = track.moods.map(normalize);
  const description = normalize(track.description);
  let score = 0;
  for (const term of terms) {
    if (id === term || title === term) score += 20;
    else if (title.includes(term)) score += 10;
    else if (genres.some((value) => value.includes(term))) score += 7;
    else if (moods.some((value) => value.includes(term))) score += 6;
    else if (artist.includes(term)) score += 4;
    else if (description.includes(term)) score += 2;
    else return 0;
  }
  return score;
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, " ").trim();
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return MUSIC_CATALOG.length;
  if (!Number.isFinite(value)) return MUSIC_CATALOG.length;
  return Math.max(0, Math.floor(value));
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
