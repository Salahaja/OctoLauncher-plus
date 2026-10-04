import { useEffect, useState } from 'react';
import cls from 'classnames';
import {
	ExternalLink,
	RefreshCw,
	ShieldCheck,
	ShieldOff,
	Timer,
	X
} from 'lucide-react';

import {
	type ElevatedResult,
	type HostStatus,
	type ServerStatus,
	type WaitStatus
} from '~main/types';
import { api } from '~renderer/utils/api';
import useScrollHint from '~renderer/utils/useScrollHint';
import { useT } from '~renderer/i18n';

import TextButton from '../styled/TextButton';

const LOGIN_CAPTURE_URL = 'https://github.com/Salahaja/octowow-login-capture';

const formatElapsed = (since: string, now: number) => {
	const s = Math.max(0, Math.round((now - Date.parse(since)) / 1000));
	const m = Math.floor(s / 60);
	return m ? `${m}m ${s % 60}s` : `${s}s`;
};

const Verdict = ({ status }: { status: ServerStatus }) => {
	const t = useT();
	const login = status.hosts.find(h => h.name === 'play.octowow.st');
	const loginAnswers = login?.addresses.some(a => a.ms !== null);

	const [text, color] = !status.dnsAnswered
		? [t('tools.verdictNoDns'), 'text-orange']
		: status.pinsStale
		? [t('tools.verdictStale'), 'text-orange']
		: !loginAnswers && status.online
		? [t('tools.verdictFiltered'), 'text-orange']
		: !status.hasBlock
		? [t('tools.verdictNotPinned'), 'text-blueGray']
		: [t('tools.verdictPinned'), 'text-warmGreen'];
	return <p className={color}>{text}</p>;
};

const HostRows = ({ host }: { host: HostStatus }) => {
	const t = useT();
	return (
		<>
			<p className="col-span-3 mt-1 font-mono text-[13px] text-white/80">
				{host.name}
			</p>
			{host.addresses.length === 0 && (
				<p className="s1 col-span-3 text-blueGray">{t('tools.noAddresses')}</p>
			)}
			{host.addresses.map(({ ip, ms }) => (
				<div key={ip} className="contents">
					<p className="s1 pl-3 font-mono">{ip}</p>
					<p className="s1 text-blueGray">
						{[
							host.dns.includes(ip) && t('tools.sourceDns'),
							host.pinned.includes(ip) && t('tools.sourcePinned'),
							host.overrides.includes(ip) && t('tools.sourceOverride')
						]
							.filter(Boolean)
							.join(' · ')}
					</p>
					<p
						className={cls(
							's1 justify-self-end',
							ms === null ? 'text-orange' : 'text-warmGreen'
						)}
					>
						{ms === null ? t('tools.noAnswer') : t('tools.answered', { ms })}
					</p>
				</div>
			))}
		</>
	);
};

const ToolsTab = () => {
	const t = useT();
	const scrollRef = useScrollHint<HTMLDivElement>();

	const status = api.server.status.useQuery(undefined, {
		refetchInterval: 60_000,
		refetchOnWindowFocus: false
	});

	const [result, setResult] = useState<ElevatedResult>();
	const pin = api.server.pinHosts.useMutation({
		onSuccess: setResult,
		onSettled: () => status.refetch()
	});
	const unpin = api.server.unpinHosts.useMutation({
		onSuccess: setResult,
		onSettled: () => status.refetch()
	});
	const busy = pin.isLoading || unpin.isLoading;

	const [wait, setWait] = useState<WaitStatus>({ state: 'idle' });
	api.server.observeWait.useSubscription(undefined, { onData: setWait });
	const startWait = api.server.waitAndLaunch.useMutation();
	const cancelWait = api.server.cancelWait.useMutation();
	const openLink = api.general.openLink.useMutation();

	const [now, setNow] = useState(Date.now());
	useEffect(() => {
		if (wait.state !== 'waiting') return;
		const id = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(id);
	}, [wait.state]);

	const data = status.data;

	return (
		<div className="tw-surface flex min-h-0 flex-grow flex-col gap-3">
			<div
				ref={scrollRef}
				className="relative -m-4 -mb-3 flex flex-grow flex-col gap-2 overflow-y-auto p-4 pb-3"
			>
				<div className="flex items-center justify-between">
					<h4 className="tw-color">{t('tools.statusHeading')}</h4>
					<TextButton
						icon={RefreshCw}
						size={18}
						loading={status.isFetching}
						onClick={() => status.refetch()}
						className="-my-2 text-blueGray"
					>
						{t('misc.refresh')}
					</TextButton>
				</div>
				{data ? (
					<>
						<p>
							{data.online !== null ? (
								<>
									<span className="text-green">●</span>{' '}
									{t('tools.online', { count: data.online.toLocaleString() })}
								</>
							) : (
								<span className="text-blueGray">{t('tools.onlineUnknown')}</span>
							)}
						</p>
						<Verdict status={data} />
						<div className="grid grid-cols-[auto_1fr_auto] items-center gap-x-4 gap-y-0.5">
							{data.hosts.map(h => (
								<HostRows key={h.name} host={h} />
							))}
						</div>
					</>
				) : (
					<p className="s1 text-blueGray">
						{status.isError ? t('tools.statusFailed') : t('tools.checking')}
					</p>
				)}

				<h4 className="tw-color mt-3">{t('tools.hostsHeading')}</h4>
				<p className="s1 text-blueGray">{t('tools.hostsText')}</p>
				<div className="-ml-2 flex items-center gap-2">
					<TextButton
						icon={ShieldCheck}
						size={18}
						loading={pin.isLoading}
						disabled={busy}
						onClick={() => pin.mutateAsync()}
						className="text-warmGreen"
					>
						{t('tools.pin')}
					</TextButton>
					<TextButton
						icon={ShieldOff}
						size={18}
						loading={unpin.isLoading}
						disabled={busy || (data && !data.hasBlock)}
						onClick={() => unpin.mutateAsync()}
						className="text-red/70"
					>
						{t('tools.unpin')}
					</TextButton>
					{busy && (
						<p className="s1 text-blueGray">{t('tools.approvePrompt')}</p>
					)}
				</div>
				{result && !busy && (
					<pre
						className={cls(
							's1 max-h-48 overflow-auto whitespace-pre-wrap border border-blueGray/20 bg-black/40 p-2 font-mono text-[12px]',
							result.ok ? 'text-blueGray' : 'text-orange'
						)}
					>
						{result.output || (result.ok ? t('tools.done') : t('tools.failed'))}
					</pre>
				)}

				<h4 className="tw-color mt-3">{t('tools.waitHeading')}</h4>
				<p className="s1 text-blueGray">{t('tools.waitText')}</p>
				<div className="-ml-2 flex items-center gap-2">
					{wait.state === 'waiting' ? (
						<>
							<TextButton
								icon={X}
								size={18}
								onClick={() => cancelWait.mutateAsync()}
								className="text-red/70"
							>
								{t('tools.waitCancel')}
							</TextButton>
							<p className="s1 text-blueGray">
								{t('tools.waiting', {
									attempts: wait.attempts,
									elapsed: formatElapsed(wait.since, now)
								})}
							</p>
						</>
					) : (
						<>
							<TextButton
								icon={Timer}
								size={18}
								onClick={() => startWait.mutateAsync()}
								className="text-warmGreen"
							>
								{t('tools.waitStart')}
							</TextButton>
							{wait.launched && (
								<p className="s1 text-warmGreen">{t('tools.waitLaunched')}</p>
							)}
							{wait.error && <p className="s1 text-orange">{wait.error}</p>}
						</>
					)}
				</div>

				<h4 className="tw-color mt-3">{t('tools.moreHeading')}</h4>
				<div className="-ml-2 flex items-center gap-2">
					<TextButton
						icon={ExternalLink}
						size={18}
						onClick={() => openLink.mutateAsync(LOGIN_CAPTURE_URL)}
						className="text-blueGray"
					>
						{t('tools.loginCapture')}
					</TextButton>
				</div>
			</div>
		</div>
	);
};

export default ToolsTab;
