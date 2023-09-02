import { Env } from './env';
import cachePurgeHandler from './handlers/cachePurge';
import directoryHandler from './handlers/directory';
import fileHandler from './handlers/file';
import {
  isCacheEnabled,
  isDirectoryPath,
  mapUrlPathToBucketPath,
} from './util';
import responses from './responses';

interface Worker {
  async fetch: (r: Request, e: Env, c: ExecutionContext) => Promise<Response>;
}

const cloudflareWorker: Worker = {
  async fetch = (request, env, ctx) => {
    const cache = caches.default;

    const shouldServeCache = isCacheEnabled(env);

    // Review: What about `OPTIONS` type?
    if (['GET', 'HEAD'].includes(request.method) === false) {
      // This endpoint is called from the sync script to purge
      //  directories that are commonly updated so we don't need to
      //  wait for the cache to expire
      if (
        shouldServeCache && // <-- simplify this big if condition either by separating this condition to variables or smaller parts that are easier to read
        env.PURGE_API_KEY !== undefined && // <-- shouldn't this always be defined?  what's the point of verifying this env var? Maybe this check should be inside cachePurgeHandler :)
        request.method === 'POST' &&
        request.url === '/_cf/cache-purge'
      ) {
        return cachePurgeHandler(request, cache, env);
      }

      return responses.METHOD_NOT_ALLOWED;
    }

    if (shouldServeCache) {
      // Caching is enabled, let's see if the request is cached
      const response = await cache.match(request);

      if (typeof response !== 'undefined') {
        response.headers.append('x-cache-status', 'hit');

        return response;
      }
    }

    const url = new URL(request.url); // <--- you should catch if URL is malformed. new URL can throw an Exception

    const bucketPath = mapUrlPathToBucketPath(url, env);

    if (typeof bucketPath === 'undefined') {
      // Directory listing is restricted and we're not on
      //  a supported path, block request
      return new Response('Unauthorized', { status: 401 });
    }

    // Review: Not a good practice to assign a variable to two completely different things
    const bucketComponents = decodeURIComponent(bucketPath);
    const isPathADirectory = isDirectoryPath(bucketPath);

    if (isPathADirectory && env.DIRECTORY_LISTING === 'off') {
      // File not found since we should only be allowing
      //  file paths if directory listing is off
      return responses.FILE_NOT_FOUND(request);
    }

    const response: Response = isPathADirectory ?
      // Directory requested, try listing it
      await directoryHandler(url, request, bucketComponents, env) :
      // File requested, try to serve it
      await fileHandler(url, request, bucketComponents, env);

    // Cache response if cache is enabled
    if (shouldServeCache && response.status !== 304) {
      ctx.waitUntil(cache.put(request, response.clone()));
    }

    response.headers.append('x-cache-status', 'miss');

    return response;
  },
};

export default cloudflareWorker;
