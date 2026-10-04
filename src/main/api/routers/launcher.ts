import { countRunningClients, startGame } from '~main/modules/launch';

import { createTRPCRouter, publicProcedure } from '../trpc';

export const launcherRouter = createTRPCRouter({
	running: publicProcedure.query(() => countRunningClients()),
	start: publicProcedure.mutation(() => startGame())
});
