import {
  Chapter,
  ChapterDetails,
  ChapterProviding,
  CloudflareBypassRequestProviding,
  ContentRating,
  DUISection,
  HomePageSectionsProviding,
  HomeSection,
  HomeSectionType,
  MangaProviding,
  PagedResults,
  PartialSourceManga,
  Request,
  Response,
  SearchRequest,
  SearchResultsProviding,
  SourceInfo,
  SourceIntents,
  SourceManga,
  TagSection,
} from "@paperback/types";

import {
  AtsuAvailableFiltersResponse,
  AtsuChaptersResponse,
  AtsuHomePageResponse,
  AtsuInfiniteResponse,
  AtsuMangaDetails,
  AtsuMangaItem,
  AtsuMangaPageResponse,
  AtsuReadChapterResponse,
  AtsuSearchDocument,
  AtsuSearchResponse,
  AtsumaruMetadata,
} from "./model";

const DOMAIN = "https://atsu.moe";
const CDN_DOMAIN = "https://cdn.atsu.moe";
const SEARCH_PAGE_SIZE = 20;

const INFINITE_ENDPOINTS: Record<string, string> = {
  "trending-carousel": "trending",
  "most-bookmarked": "mostBookmarked",
  "recently-updated": "recentlyUpdated",
  popular: "popular",
  "recently-added": "recentlyAdded",
};

const SORT_OPTIONS: Array<{ id: string; label: string }> = [
  { id: "views:desc", label: "Popularity" },
  { id: "trending:desc", label: "Trending" },
  { id: "dateAdded:desc", label: "Date Added" },
  { id: "releaseDate:desc", label: "Release Date" },
  { id: "mbRating:desc", label: "Top Rated" },
];

const MIN_CHAPTER_OPTIONS = [10, 25, 50, 100];
const OLDEST_RELEASE_YEAR = 1970;
const SHOW_ADULT_KEY = "show_adult";

export const AtsumaruInfo: SourceInfo = {
  version: "1.0.1",
  name: "Atsumaru",
  description: `Extension that pulls content from ${DOMAIN}`,
  author: "Lucifer's Circle",
  icon: "icon.png",
  contentRating: ContentRating.EVERYONE,
  websiteBaseURL: DOMAIN,
  intents:
    SourceIntents.MANGA_CHAPTERS |
    SourceIntents.HOMEPAGE_SECTIONS |
    SourceIntents.CLOUDFLARE_BYPASS_REQUIRED |
    SourceIntents.SETTINGS_UI,
  sourceTags: [],
};

export class Atsumaru
  implements
  ChapterProviding,
  HomePageSectionsProviding,
  MangaProviding,
  SearchResultsProviding,
  CloudflareBypassRequestProviding {
  stateManager = App.createSourceStateManager();

  requestManager = App.createRequestManager({
    requestsPerSecond: 10,
    requestTimeout: 20000,
    interceptor: {
      interceptRequest: async (request: Request): Promise<Request> => {
        request.headers = {
          ...(request.headers ?? {}),
          referer: `${DOMAIN}/`,
          "user-agent": await this.requestManager.getDefaultUserAgent(),
        };
        return request;
      },
      interceptResponse: async (response: Response): Promise<Response> => {
        return response;
      },
    },
  });

  async getSourceMenu(): Promise<DUISection> {
    return App.createDUISection({
      id: "settings",
      header: "Atsumaru Settings",
      isHidden: false,
      rows: async () => [
        App.createDUISwitch({
          id: SHOW_ADULT_KEY,
          label: "Show Adult Content",
          value: App.createDUIBinding({
            get: async () => await this.getShowAdult(),
            set: async (value: boolean) =>
              await this.stateManager.store(SHOW_ADULT_KEY, value),
          }),
        }),
      ],
    });
  }

  async getHomePageSections(
    sectionCallback: (section: HomeSection) => void
  ): Promise<void> {
    const data = await this.fetchJSON<AtsuHomePageResponse>(
      `${DOMAIN}/api/home/page${(await this.getShowAdult()) ? "?adult=1" : ""}`
    );

    for (const section of data.homePage.sections) {
      if (section.layout !== "carousel" || section.key === "hot-updates") {
        continue;
      }

      sectionCallback(
        App.createHomeSection({
          id: section.key,
          title: section.title ?? "Unknown",
          type:
            section.key === "trending-carousel"
              ? HomeSectionType.featured
              : HomeSectionType.singleRowNormal,
          items: (section.items ?? []).map((item) => this.createPartialManga(item)),
          containsMoreItems: section.key in INFINITE_ENDPOINTS,
        })
      );
    }
  }

  async getViewMoreItems(
    homepageSectionId: string,
    metadata: AtsumaruMetadata | undefined
  ): Promise<PagedResults> {
    const endpoint = INFINITE_ENDPOINTS[homepageSectionId];
    if (!endpoint) {
      return App.createPagedResults({ results: [] });
    }

    const page = metadata?.page ?? 0;
    const data = await this.fetchJSON<AtsuInfiniteResponse>(
      `${DOMAIN}/api/infinite/${endpoint}?page=${page}&types=${encodeURIComponent("Manga,Manwha,Manhua")}${(await this.getShowAdult()) ? "&adult=1" : ""}`
    );

    const results = data.items.map((item) => this.createPartialManga(item));

    return App.createPagedResults({
      results,
      metadata: results.length > 0 ? { page: page + 1 } : undefined,
    });
  }

  async getSearchTags(): Promise<TagSection[]> {
    const filters = await this.fetchJSON<AtsuAvailableFiltersResponse>(
      `${DOMAIN}/api/explore/availableFilters`
    );

    const sections: TagSection[] = [];

    if (filters.genres.length > 0) {
      sections.push(
        App.createTagSection({
          id: "genres",
          label: "Genres",
          tags: filters.genres.map((genre) =>
            App.createTag({ id: genre.id, label: genre.name })
          ),
        })
      );
    }

    if (filters.types.length > 0) {
      sections.push(
        App.createTagSection({
          id: "types",
          label: "Types",
          tags: filters.types.map((type) =>
            App.createTag({ id: `type-${type.id}`, label: type.name })
          ),
        })
      );
    }

    if (filters.statuses.length > 0) {
      sections.push(
        App.createTagSection({
          id: "statuses",
          label: "Status",
          tags: filters.statuses.map((status) =>
            App.createTag({ id: `status-${status.id}`, label: status.name })
          ),
        })
      );
    }

    const currentYear = new Date().getFullYear();
    const years: number[] = [];
    for (let year = currentYear + 1; year >= OLDEST_RELEASE_YEAR; year--) {
      years.push(year);
    }
    sections.push(
      App.createTagSection({
        id: "years",
        label: "Release Year",
        tags: years.map((year) =>
          App.createTag({ id: `year-${year}`, label: String(year) })
        ),
      })
    );

    sections.push(
      App.createTagSection({
        id: "min_chapters",
        label: "Minimum Chapters",
        tags: MIN_CHAPTER_OPTIONS.map((count) =>
          App.createTag({ id: `minchap-${count}`, label: `${count}+ Chapters` })
        ),
      })
    );

    sections.push(
      App.createTagSection({
        id: "translation",
        label: "Translation",
        tags: [
          App.createTag({
            id: "official-translation",
            label: "Official Translation Only",
          }),
        ],
      })
    );

    sections.push(
      App.createTagSection({
        id: "sort",
        label: "Sort By",
        tags: SORT_OPTIONS.map((option) =>
          App.createTag({ id: `sort-${option.id}`, label: option.label })
        ),
      })
    );

    return sections;
  }

  async getSearchResults(
    query: SearchRequest,
    metadata: AtsumaruMetadata | undefined
  ): Promise<PagedResults> {
    const page = metadata?.page ?? 1;
    const searchTerm = query.title?.trim() || "*";

    const includedGenres: string[] = [];
    const includedTypes: string[] = [];
    const includedStatuses: string[] = [];
    const selectedYears: number[] = [];
    let minChapters = 0;
    let officialOnly = false;
    let sortBy = "views:desc";

    for (const tag of query.includedTags ?? []) {
      if (tag.id.startsWith("type-")) {
        includedTypes.push(tag.id.replace("type-", ""));
      } else if (tag.id.startsWith("status-")) {
        includedStatuses.push(tag.id.replace("status-", ""));
      } else if (tag.id.startsWith("year-")) {
        selectedYears.push(Number(tag.id.replace("year-", "")));
      } else if (tag.id.startsWith("minchap-")) {
        minChapters = Math.max(minChapters, Number(tag.id.replace("minchap-", "")));
      } else if (tag.id === "official-translation") {
        officialOnly = true;
      } else if (tag.id.startsWith("sort-")) {
        sortBy = tag.id.replace("sort-", "");
      } else {
        includedGenres.push(tag.id);
      }
    }

    const excludedGenres = (query.excludedTags ?? [])
      .map((tag) => tag.id)
      .filter((id) => /^\d+$/.test(id));

    const filterBy: string[] = [];
    if (!(await this.getShowAdult())) {
      filterBy.push("isAdult:=false");
    }
    if (sortBy === "mbRating:desc") {
      filterBy.push("mbRating:>0");
    } else if (sortBy === "views:desc") {
      filterBy.push("views:>0");
    }
    for (const genre of includedGenres) {
      filterBy.push(`genreIds:=${this.escapeFilterValue(genre)}`);
    }
    if (excludedGenres.length > 0) {
      filterBy.push(
        `genreIds:!=[${excludedGenres.map((genre) => this.escapeFilterValue(genre)).join(",")}]`
      );
    }
    if (includedTypes.length > 0) {
      filterBy.push(
        `type:=[${includedTypes.map((type) => this.escapeFilterValue(type)).join(",")}]`
      );
    }
    if (includedStatuses.length > 0) {
      filterBy.push(
        `status:=[${includedStatuses.map((status) => this.escapeFilterValue(status)).join(",")}]`
      );
    }
    if (selectedYears.length > 0) {
      filterBy.push(`releaseYear:=[${selectedYears.join(",")}]`);
    }
    if (minChapters > 0) {
      filterBy.push(`chapterCount:>=${minChapters}`);
    }
    if (officialOnly) {
      filterBy.push("officialTranslation:=true");
    }

    const params = [
      `q=${encodeURIComponent(searchTerm)}`,
      `query_by=${encodeURIComponent("title,englishTitle,otherNames,authors")}`,
      `query_by_weights=${encodeURIComponent("4,3,2,1")}`,
      `num_typos=${encodeURIComponent("4,3,2,1")}`,
      `include_fields=${encodeURIComponent("id,title,englishTitle,poster,posterSmall,posterMedium,type")}`,
      `filter_by=${encodeURIComponent(filterBy.join(" && "))}`,
      `page=${page}`,
      `per_page=${SEARCH_PAGE_SIZE}`,
      `sort_by=${encodeURIComponent(sortBy)}`,
    ].join("&");

    const data = await this.fetchJSON<AtsuSearchResponse>(
      `${DOMAIN}/collections/manga/documents/search?${params}`
    );

    const hits = data.hits ?? [];
    const results = hits.map(({ document }) =>
      App.createPartialSourceManga({
        mangaId: document.id,
        title: document.title || document.englishTitle || "",
        image: this.buildThumbnailUrl(document),
        subtitle: document.type || undefined,
      })
    );

    const hasNextPage = page * SEARCH_PAGE_SIZE < data.found && hits.length > 0;

    return App.createPagedResults({
      results,
      metadata: hasNextPage ? { page: page + 1 } : undefined,
    });
  }

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    const manga = await this.fetchMangaPage(mangaId);

    const titles = [manga.title, manga.englishTitle, ...(manga.otherNames ?? [])]
      .map((title) => title?.trim())
      .filter((title): title is string => !!title);

    const tags: TagSection[] = [];
    if (manga.genres.length > 0) {
      tags.push(
        App.createTagSection({
          id: "genres",
          label: "Genres",
          tags: manga.genres.map((genre) =>
            App.createTag({ id: genre.id, label: genre.name })
          ),
        })
      );
    }

    return App.createSourceManga({
      id: mangaId,
      mangaInfo: App.createMangaInfo({
        titles: Array.from(new Set(titles)),
        image: this.buildThumbnailUrl(manga.poster.image),
        author: manga.authors.map((author) => author.name).join(", ") || undefined,
        desc: manga.synopsis,
        status: this.parseStatus(manga.status),
        tags,
        hentai: false,
      }),
    });
  }

  async getChapters(mangaId: string): Promise<Chapter[]> {
    let manga: AtsuMangaDetails;
    try {
      manga = await this.fetchMangaPage(mangaId);
    } catch {
      manga = await this.fetchMangaPage(await this.resolveStaleMangaId(mangaId));
    }
    const scanlatorMap = new Map(
      (manga.scanlators ?? []).map((scanlator) => [scanlator.id, scanlator.name])
    );

    const data = await this.fetchJSON<AtsuChaptersResponse>(
      `${DOMAIN}/api/manga/allChapters?mangaId=${encodeURIComponent(manga.id)}`
    );

    const sorted = data.chapters
      .map((chapter) => ({
        chapter,
        group: chapter.scanlationMangaId
          ? (scanlatorMap.get(chapter.scanlationMangaId) ?? "No Group")
          : "No Group",
      }))
      .sort((a, b) => {
        if (a.chapter.number !== b.chapter.number) {
          return b.chapter.number - a.chapter.number;
        }
        return a.group.localeCompare(b.group);
      });

    return sorted.map(({ chapter, group }, index) => {
      const name = chapter.title
        .replace(/^((Chapter|Episode|Ch\.?)\s*[\d.]+|#\s*[\d.]+)\s*(\bS\d+\b)?\s*[-:]?\s*/i, "")
        .trim();
      const volume = Number(chapter.title.match(/\bS(\d+)\b/i)?.[1] ?? 0);

      return App.createChapter({
        id: chapter.id,
        name,
        chapNum: chapter.number,
        volume,
        group,
        time: new Date(chapter.createdAt),
        langCode: "en",
        sortingIndex: sorted.length - index,
      });
    });
  }

  async getChapterDetails(mangaId: string, chapterId: string): Promise<ChapterDetails> {
    const data = await this.fetchJSON<AtsuReadChapterResponse>(
      `${DOMAIN}/api/read/chapter?mangaId=${encodeURIComponent(mangaId)}&chapterId=${encodeURIComponent(chapterId)}`
    );

    const pages = data.readChapter.pages
      .sort((a, b) => a.number - b.number)
      .map((page) =>
        page.image.startsWith("http") ? page.image : `${CDN_DOMAIN}${page.image}`
      );

    return App.createChapterDetails({
      id: chapterId,
      mangaId,
      pages,
    });
  }

  async getCloudflareBypassRequestAsync(): Promise<Request> {
    return App.createRequest({
      url: DOMAIN,
      method: "GET",
      headers: {
        referer: `${DOMAIN}/`,
        "user-agent": await this.requestManager.getDefaultUserAgent(),
      },
    });
  }

  getMangaShareUrl(mangaId: string): string {
    return `${DOMAIN}/manga/${mangaId}`;
  }

  private async getShowAdult(): Promise<boolean> {
    return ((await this.stateManager.retrieve(SHOW_ADULT_KEY)) as boolean) ?? false;
  }

  private async fetchJSON<T>(url: string): Promise<T> {
    const request = App.createRequest({ url, method: "GET" });
    const response = await this.requestManager.schedule(request, 1);

    if (response.status !== 200) {
      throw new Error(`Request failed with status ${response.status}: ${url}`);
    }

    return JSON.parse(response.data as string) as T;
  }

  private async fetchMangaPage(mangaId: string): Promise<AtsuMangaDetails> {
    const request = App.createRequest({
      url: `${DOMAIN}/manga/${mangaId}`,
      method: "GET",
    });
    const response = await this.requestManager.schedule(request, 1);
    const html = response.data as string;

    const match = html.match(/window\.mangaPage\s*=\s*({[\s\S]*?});/);
    if (!match?.[1]) {
      throw new Error(`Could not find manga data on page: ${mangaId}`);
    }

    const manga = (JSON.parse(match[1]) as AtsuMangaPageResponse).mangaPage;
    await this.stateManager.store(`title-${mangaId}`, manga.title);
    return manga;
  }

  private async resolveStaleMangaId(mangaId: string): Promise<string> {
    const title = (await this.stateManager.retrieve(`title-${mangaId}`)) as
      | string
      | undefined;
    if (!title) {
      throw new Error(`Could not resolve manga ID: ${mangaId}`);
    }

    const params = [
      `q=${encodeURIComponent(title)}`,
      `query_by=${encodeURIComponent("title,englishTitle")}`,
      `include_fields=${encodeURIComponent("id,title,englishTitle")}`,
      "page=1",
      "per_page=5",
    ].join("&");

    const data = await this.fetchJSON<AtsuSearchResponse>(
      `${DOMAIN}/collections/manga/documents/search?${params}`
    );

    const resolvedId = (data.hits ?? []).find(
      ({ document }) => document.title === title || document.englishTitle === title
    )?.document.id;

    if (!resolvedId) {
      throw new Error(`Could not resolve manga ID for: ${title}`);
    }

    return resolvedId;
  }

  private createPartialManga(item: AtsuMangaItem): PartialSourceManga {
    return App.createPartialSourceManga({
      mangaId: item.id,
      title: item.title,
      image: this.buildThumbnailUrl(item.image),
      subtitle: item.type || undefined,
    });
  }

  private buildThumbnailUrl(
    source: string | AtsuSearchDocument | undefined
  ): string {
    const imagePath =
      typeof source === "string"
        ? source
        : (source?.posterMedium ?? source?.posterSmall ?? source?.poster);
    if (!imagePath) return "";
    if (imagePath.startsWith("http")) return imagePath;
    return `${DOMAIN}${imagePath.startsWith("/") ? imagePath : `/static/${imagePath}`}`;
  }

  private parseStatus(raw: string): string {
    const status = raw.toLowerCase();
    if (status.includes("ongoing")) return "ONGOING";
    if (status.includes("complet")) return "COMPLETED";
    if (status.includes("hiatus")) return "HIATUS";
    if (status.includes("cancel") || status.includes("dropped")) return "ABANDONED";
    return "UNKNOWN";
  }

  private escapeFilterValue(value: string): string {
    return `\`${value.replace(/\\/g, "\\\\").replace(/`/g, "\\`")}\``;
  }
}
