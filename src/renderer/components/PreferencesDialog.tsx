import { useForm } from 'react-hook-form';
import { useEffect, useState } from 'react';
import {
	FilePen,
	FolderOpen,
	HelpCircle,
	RefreshCw,
	ScrollText,
	ShieldAlert,
	ShieldCheck
} from 'lucide-react';

import { PreferencesSchema } from '~common/schemas';
import { api } from '~renderer/utils/api';
import zodResolver from '~renderer/utils/zodResolver';
import { useT } from '~renderer/i18n';

import TextButton from './styled/TextButton';
import CheckboxInput from './form/CheckboxInput';
import DialogButton from './styled/DialogButton';
import ClientDirDialog from './ClientDirDialog';
import CloseButton from './styled/CloseButton';

const MirrorStatus = () => {
	const t = useT();
	const [state, setState] = useState<string>('verifying');
	api.updater.observe.useSubscription(undefined, {
		onData: ({ state }) => setState(state)
	});

	if (state === 'serverUnreachable')
		return <span className="s1 text-red">{t('prefs.mirrorOffline')}</span>;
	if (state === 'verifying' || state === 'updating')
		return (
			<span className="s1 text-blueGray">{t('prefs.mirrorChecking')}</span>
		);
	return <span className="s1 text-warmGreen">{t('prefs.mirrorOnline')}</span>;
};

type Props = { close: () => void };

const PreferencesDialog = ({ close }: Props) => {
	const t = useT();
	const { data: pref } = api.preferences.get.useQuery();
	const setPref = api.preferences.set.useMutation();

	const verify = api.updater.verify.useMutation();
	const repair = api.mods.repair.useMutation();
	const openInstallFolder = api.general.openInstallFolder.useMutation();
	const openLogFile = api.general.openLogFile.useMutation();
	const addExclusion = api.general.addDefenderExclusion.useMutation();

	const { handleSubmit, watch, setValue, reset } = useForm({
		defaultValues: pref ?? {},
		resolver: zodResolver(PreferencesSchema)
	});
	const [saveError, setSaveError] = useState<string | null>(null);

	useEffect(() => {
		pref && reset(pref);
	}, [reset, pref]);

	const setBool = (key: keyof PreferencesSchema) => (v: boolean) =>
		setValue(key, v, {
			shouldTouch: true,
			shouldDirty: true,
			shouldValidate: true
		});

	return (
		<form
			className="tw-dialog !w-fit min-w-[480px] max-w-[640px] !gap-1"
			onSubmit={handleSubmit(async v => {
				setSaveError(null);
				try {
					await setPref.mutateAsync({
						cleanWdb: v.cleanWdb,
						minimizeToTrayOnPlay: v.minimizeToTrayOnPlay,
						shareDownloads: v.shareDownloads
					});
					close();
				} catch (e) {
					setSaveError(e instanceof Error ? e.message : String(e));
				}
			})}
		>
			<CloseButton
				close={() => {
					reset();
					close();
				}}
			/>
			<h3 className="tw-color">{t('prefs.title')}</h3>
			<hr className="mb-1" />

			<div className="flex items-center gap-3">
				<h4 className="tw-color">{t('prefs.installLocation')}</h4>
				<TextButton
					icon={FolderOpen}
					size={14}
					onClick={() => openInstallFolder.mutateAsync()}
					className="!p-1 text-blueGray"
				>
					{t('prefs.openFolder')}
				</TextButton>
			</div>
			<div className="flex items-center gap-2 border border-blueGray/20 bg-darkGray/40 px-3 py-1">
				<span
					title={pref?.clientDir}
					className="min-w-0 shrink grow overflow-hidden text-ellipsis whitespace-nowrap"
				>
					{pref?.clientDir ?? t('prefs.notSelected')}
				</span>
				<DialogButton
					dialog={closeInner => (
						<ClientDirDialog
							close={() => {
								closeInner();
								close();
							}}
						/>
					)}
					clickAway={pref?.isPortable}
				>
					{open => (
						<TextButton
							icon={FilePen}
							size={14}
							onClick={open}
							className="!p-1"
						>
							{t('prefs.change')}
						</TextButton>
					)}
				</DialogButton>
			</div>

			<div className="mt-1 flex items-center gap-3">
				<h4 className="tw-color">{t('prefs.downloadMirror')}</h4>
			</div>
			<div className="flex items-center gap-2 pl-2">
				<input type="radio" checked readOnly className="accent-warmGreen" />
				<span>Iceland</span>
				<MirrorStatus />
				<TextButton
					icon={RefreshCw}
					size={12}
					onClick={() => verify.mutateAsync()}
					title={t('prefs.recheck')}
					className="!p-0 text-blueGray"
				/>
			</div>

			<div className="flex items-start gap-3">
				<div className="flex min-w-0 flex-col">
					<h4 className="tw-color">{t('prefs.troubleshooting')}</h4>
					<TextButton
						icon={ShieldCheck}
						onClick={() => repair.mutateAsync().then(close)}
						className="!items-start text-left text-warmGreen"
					>
						{t('prefs.verifyGameFiles')}
					</TextButton>
					<TextButton
						icon={ScrollText}
						onClick={() => openLogFile.mutateAsync()}
						className="!items-start text-left text-pink"
					>
						{t('prefs.openLogFile')}
					</TextButton>
					<div className="flex items-start">
						<TextButton
							icon={ShieldAlert}
							onClick={() => addExclusion.mutateAsync()}
							loading={addExclusion.isLoading}
							className="!items-start text-left text-orange"
						>
							{t('prefs.allowThroughAntivirus')}
						</TextButton>
						{/* sits on the label's first line even when a locale wraps it */}
						<TextButton
							icon={HelpCircle}
							size={14}
							onClick={() => window.dispatchEvent(new Event('av-help'))}
							title={t('av.whatAllowDoesTitle')}
							className="mt-[14px] !p-0 text-yellow hocus:!text-yellow"
						/>
					</div>
					{addExclusion.data?.ok === true && (
						<span className="s1 text-warmGreen">
							{t('prefs.exclusionAdded')}
						</span>
					)}
					{addExclusion.data?.ok === false && (
						<span className="s1 text-orange">{addExclusion.data.error}</span>
					)}
				</div>

				<div className="flex min-w-0 flex-col">
					<h4 className="tw-color">{t('prefs.generalSettings')}</h4>
					<CheckboxInput
						value={!!watch('cleanWdb')}
						setValue={setBool('cleanWdb')}
						label={t('prefs.cleanWdb')}
					/>
					<CheckboxInput
						value={!!watch('minimizeToTrayOnPlay')}
						setValue={setBool('minimizeToTrayOnPlay')}
						label={t('prefs.minimizeToTray')}
					/>
					<CheckboxInput
						value={watch('shareDownloads') !== false}
						setValue={setBool('shareDownloads')}
						label={t('prefs.shareDownloads')}
					/>
				</div>
			</div>

			{saveError && (
				<span className="s1 self-end text-orange">{saveError}</span>
			)}
			<TextButton type="submit" className="mt-1 self-end text-green">
				{t('prefs.save')}
			</TextButton>
		</form>
	);
};

export default PreferencesDialog;
