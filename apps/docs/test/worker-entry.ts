import { onRequest } from '../functions/_middleware';

type Env = { ASSETS: Fetcher };

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const context = {
			request,
			env,
			functionPath: '/',
			params: {},
			data: {},
			waitUntil: () => {},
			passThroughOnException: () => {},
			next: async () => env.ASSETS.fetch(request),
		};

		return onRequest(context as Parameters<typeof onRequest>[0]);
	},
};
