import {
	ServerWaiter,
	checkServer,
	pinHosts,
	unpinHosts
} from '~main/modules/serverTools';

import { createTRPCRouter, publicProcedure } from '../trpc';

export const serverRouter = createTRPCRouter({
	status: publicProcedure.query(() => checkServer()),
	pinHosts: publicProcedure.mutation(() => pinHosts()),
	unpinHosts: publicProcedure.mutation(() => unpinHosts()),
	waitAndLaunch: publicProcedure.mutation(() => ServerWaiter.start()),
	cancelWait: publicProcedure.mutation(() => ServerWaiter.cancel()),
	observeWait: publicProcedure.subscription(() => ServerWaiter.observe())
});
