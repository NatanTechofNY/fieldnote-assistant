import "@testing-library/jest-dom/vitest";

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

vi.stubGlobal("ResizeObserver", ResizeObserverMock);

type SearchRequest = { indexName: string };
type SearchParams = SearchRequest[] | { requests?: SearchRequest[] };

/**
 * InstantSearch issues a real query as soon as it mounts. Without this the
 * agent chat test reaches Algolia's hosts, and the resulting unhandled
 * rejection fails the run even though every assertion passed.
 */
vi.mock("algoliasearch/lite", () => ({
  liteClient: (appId: string, apiKey: string) => ({
    // The Chat connector reads these off the client to build its agent URL.
    appId,
    apiKey,
    addAlgoliaAgent() {},
    search: async (params: SearchParams) => {
      const requests = Array.isArray(params) ? params : params?.requests ?? [];
      return {
        results: requests.map(({ indexName }) => ({
          hits: [],
          nbHits: 0,
          page: 0,
          nbPages: 0,
          hitsPerPage: 20,
          exhaustiveNbHits: true,
          query: "",
          params: "",
          processingTimeMS: 0,
          index: indexName,
        })),
      };
    },
  }),
}));
