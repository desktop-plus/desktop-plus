import * as React from 'react'
import { TabBar, TabBarType } from '../tab-bar'
import { Remote } from './remote'
import { GitIgnore } from './git-ignore'
import { assertNever } from '../../lib/fatal-error'
import { IRemote } from '../../models/remote'
import { Dispatcher } from '../dispatcher'
import { PopupType } from '../../models/popup'
import {
  Repository,
  getForkContributionTarget,
  isRepositoryWithForkedGitHubRepository,
} from '../../models/repository'
import { Dialog, DialogError, DialogFooter } from '../dialog'
import { NoRemote } from './no-remote'
import { readGitIgnoreAtRoot } from '../../lib/git'
import { OkCancelButtonGroup } from '../dialog/ok-cancel-button-group'
import { ForkSettings } from './fork-settings'
import { ForkContributionTarget } from '../../models/workflow-preferences'
import { GitConfigLocation, GitConfig } from './git-config'
import {
  getConfigValue,
  getGlobalConfigValue,
  removeConfigValue,
  setConfigValue,
} from '../../lib/git/config'
import {
  gitAuthorNameIsValid,
  InvalidGitAuthorNameMessage,
} from '../lib/identifier-rules'
import { Account } from '../../models/account'
import { Octicon } from '../octicons'
import * as octicons from '../octicons/octicons.generated'
import { Integrations } from './integrations'
import { ICustomIntegration } from '../../lib/custom-integration'
import { getAvailableEditors } from '../../lib/editors/lookup'

interface IRepositorySettingsProps {
  readonly initialSelectedTab?: RepositorySettingsTab
  readonly dispatcher: Dispatcher
  readonly remote: IRemote | null
  readonly repository: Repository
  readonly repositoryAccount: Account | null
  readonly accounts: ReadonlyArray<Account>
  readonly onDismissed: () => void
}

export enum RepositorySettingsTab {
  Remote = 0,
  IgnoredFiles,
  GitConfig,
  Integrations,
  ForkSettings,
}

interface IRepositorySettingsState {
  readonly selectedTab: RepositorySettingsTab
  readonly remote: IRemote | null
  readonly defaultBranch: string | undefined
  readonly ignoreText: string | null
  readonly ignoreTextHasChanged: boolean
  readonly disabled: boolean
  readonly saveDisabled: boolean
  readonly gitConfigLocation: GitConfigLocation
  readonly committerName: string
  readonly committerEmail: string
  readonly globalCommitterName: string
  readonly globalCommitterEmail: string
  readonly initialGitConfigLocation: GitConfigLocation
  readonly initialCommitterName: string | null
  readonly initialCommitterEmail: string | null
  readonly errors?: ReadonlyArray<JSX.Element | string>
  readonly forkContributionTarget: ForkContributionTarget
  readonly isLoadingGitConfig: boolean
  readonly availableEditors: ReadonlyArray<string>
  readonly useDefaultEditor: boolean
  readonly selectedExternalEditor: string | null
  readonly useCustomEditor: boolean
  readonly customEditor: ICustomIntegration
  readonly repositoryAccount: Account | null
}

export class RepositorySettings extends React.Component<
  IRepositorySettingsProps,
  IRepositorySettingsState
> {
  public constructor(props: IRepositorySettingsProps) {
    super(props)

    this.state = {
      selectedTab:
        this.props.initialSelectedTab || RepositorySettingsTab.Remote,
      remote: props.remote,
      defaultBranch: props.repository.defaultBranch ?? undefined,
      ignoreText: null,
      ignoreTextHasChanged: false,
      disabled: false,
      forkContributionTarget: getForkContributionTarget(props.repository),
      saveDisabled: false,
      gitConfigLocation: GitConfigLocation.Global,
      committerName: '',
      committerEmail: '',
      globalCommitterName: '',
      globalCommitterEmail: '',
      initialGitConfigLocation: GitConfigLocation.Global,
      initialCommitterName: null,
      initialCommitterEmail: null,
      isLoadingGitConfig: true,
      availableEditors: [],
      useDefaultEditor: !props.repository.customEditorOverride,
      selectedExternalEditor:
        props.repository.customEditorOverride?.selectedExternalEditor ?? null,
      useCustomEditor:
        props.repository.customEditorOverride?.useCustomEditor || false,
      customEditor: props.repository.customEditorOverride?.customEditor ?? {
        path: '',
        arguments: '',
      },
      repositoryAccount: props.repositoryAccount,
    }
  }

  public async componentWillMount() {
    try {
      const ignoreText = await readGitIgnoreAtRoot(this.props.repository)
      this.setState({ ignoreText })
    } catch (e) {
      log.error(
        `RepositorySettings: unable to read root .gitignore file for ${this.props.repository.path}`,
        e
      )
      this.setState({ errors: [`Could not read root .gitignore: ${e}`] })
    }

    const localCommitterName = await getConfigValue(
      this.props.repository,
      'user.name',
      true
    )
    const localCommitterEmail = await getConfigValue(
      this.props.repository,
      'user.email',
      true
    )

    const editors = await getAvailableEditors()
    const availableEditors = editors.map(e => e.editor) ?? null

    const globalCommitterName = (await getGlobalConfigValue('user.name')) || ''
    const globalCommitterEmail =
      (await getGlobalConfigValue('user.email')) || ''

    const gitConfigLocation =
      localCommitterName === null && localCommitterEmail === null
        ? GitConfigLocation.Global
        : GitConfigLocation.Local

    let committerName = globalCommitterName
    let committerEmail = globalCommitterEmail

    if (gitConfigLocation === GitConfigLocation.Local) {
      committerName = localCommitterName ?? ''
      committerEmail = localCommitterEmail ?? ''
    }

    this.setState({
      gitConfigLocation,
      committerName,
      committerEmail,
      availableEditors,
      globalCommitterName,
      globalCommitterEmail,
      initialGitConfigLocation: gitConfigLocation,
      initialCommitterName: localCommitterName,
      initialCommitterEmail: localCommitterEmail,
      isLoadingGitConfig: false,
    })
  }

  private renderErrors(): JSX.Element[] | null {
    const errors = this.state.errors

    if (!errors || !errors.length) {
      return null
    }

    return errors.map((err, ix) => {
      const key = `err-${ix}`
      return <DialogError key={key}>{err}</DialogError>
    })
  }

  public render() {
    const showForkSettings = isRepositoryWithForkedGitHubRepository(
      this.props.repository
    )

    return (
      <Dialog
        id="repository-settings"
        title={__DARWIN__ ? 'Repository Settings' : 'Repository settings'}
        onDismissed={this.props.onDismissed}
        onSubmit={this.onSubmit}
        disabled={this.state.disabled}
      >
        {this.renderErrors()}

        <div className="tab-container">
          <TabBar
            onTabClicked={this.onTabClicked}
            selectedIndex={this.state.selectedTab}
            type={TabBarType.Vertical}
          >
            <span>
              <Octicon className="icon" symbol={octicons.server} />
              Remote
            </span>
            <span>
              <Octicon className="icon" symbol={octicons.file} />
              {__DARWIN__ ? 'Ignored Files' : 'Ignored files'}
            </span>
            <span>
              <Octicon className="icon" symbol={octicons.gitCommit} />
              {__DARWIN__ ? 'Git Config' : 'Git config'}
            </span>
            <span>
              <Octicon className="icon" symbol={octicons.person} />
              Integrations
            </span>
            {showForkSettings && (
              <span>
                <Octicon className="icon" symbol={octicons.repoForked} />
                {__DARWIN__ ? 'Fork Behavior' : 'Fork behavior'}
              </span>
            )}
          </TabBar>

          <div className="active-tab">{this.renderActiveTab()}</div>
        </div>
        <DialogFooter>
          <OkCancelButtonGroup
            okButtonText="Save"
            okButtonDisabled={this.state.saveDisabled}
          />
        </DialogFooter>
      </Dialog>
    )
  }

  private renderActiveTab() {
    const tab = this.state.selectedTab
    switch (tab) {
      case RepositorySettingsTab.Remote: {
        const remote = this.state.remote
        if (remote) {
          return (
            <Remote
              remote={remote}
              repository={this.props.repository}
              accounts={this.props.accounts}
              account={this.state.repositoryAccount}
              defaultBranch={this.state.defaultBranch}
              onRemoteUrlChanged={this.onRemoteUrlChanged}
              onDefaultBranchChanged={this.onDefaultBranchChanged}
              onSelectedAccountChanged={this.onSelectedAccountChanged}
            />
          )
        } else {
          return <NoRemote onPublish={this.onPublish} />
        }
      }
      case RepositorySettingsTab.IgnoredFiles: {
        return (
          <GitIgnore
            text={this.state.ignoreText}
            onIgnoreTextChanged={this.onIgnoreTextChanged}
            onShowExamples={this.onShowGitIgnoreExamples}
          />
        )
      }
      case RepositorySettingsTab.ForkSettings: {
        if (!isRepositoryWithForkedGitHubRepository(this.props.repository)) {
          return null
        }

        return (
          <ForkSettings
            forkContributionTarget={this.state.forkContributionTarget}
            repository={this.props.repository}
            onForkContributionTargetChanged={
              this.onForkContributionTargetChanged
            }
          />
        )
      }

      case RepositorySettingsTab.GitConfig: {
        return (
          <GitConfig
            account={this.props.repositoryAccount}
            gitConfigLocation={this.state.gitConfigLocation}
            onGitConfigLocationChanged={this.onGitConfigLocationChanged}
            name={this.state.committerName}
            email={this.state.committerEmail}
            globalName={this.state.globalCommitterName}
            globalEmail={this.state.globalCommitterEmail}
            onNameChanged={this.onCommitterNameChanged}
            onEmailChanged={this.onCommitterEmailChanged}
            isLoadingGitConfig={this.state.isLoadingGitConfig}
          />
        )
      }

      case RepositorySettingsTab.Integrations: {
        return (
          <Integrations
            useDefaultEditor={this.state.useDefaultEditor}
            availableEditors={this.state.availableEditors}
            selectedExternalEditor={this.state.selectedExternalEditor}
            useCustomEditor={this.state.useCustomEditor}
            customEditor={this.state.customEditor}
            onUseDefaultEditorChanged={this.onUseDefaultEditorChanged}
            onSelectedEditorChanged={this.onSelectedEditorChanged}
            onUseCustomEditorChanged={this.onUseCustomEditorChanged}
            onCustomEditorChanged={this.onCustomEditorChanged}
          />
        )
      }

      default:
        return assertNever(tab, `Unknown tab type: ${tab}`)
    }
  }

  private onPublish = () => {
    this.props.dispatcher.showPopup({
      type: PopupType.PublishRepository,
      repository: this.props.repository,
    })
  }

  private onShowGitIgnoreExamples = () => {
    this.props.dispatcher.openInBrowser('https://git-scm.com/docs/gitignore')
  }

  private onSubmit = async () => {
    this.setState({ disabled: true, errors: undefined })
    const errors = new Array<JSX.Element | string>()

    if (this.state.remote && this.props.remote) {
      const trimmedUrl = this.state.remote.url.trim()

      if (trimmedUrl !== this.props.remote.url) {
        try {
          await this.props.dispatcher.setRemoteURL(
            this.props.repository,
            this.props.remote.name,
            trimmedUrl
          )
        } catch (e) {
          log.error(
            `RepositorySettings: unable to set remote URL at ${this.props.repository.path}`,
            e
          )
          errors.push(`Failed setting the remote URL: ${e}`)
        }
      }
    }

    if (
      this.state.defaultBranch &&
      this.state.defaultBranch !== this.props.repository.defaultBranch
    ) {
      try {
        await this.props.dispatcher.updateRepositoryDefaultBranch(
          this.props.repository,
          this.state.defaultBranch
        )
      } catch (e) {
        log.error(
          `RepositorySettings: unable to change default branch at ${this.props.repository.path}`,
          e
        )
        errors.push(`Failed changing the default branch: ${e}`)
      }
    }

    if (this.state.ignoreTextHasChanged && this.state.ignoreText !== null) {
      try {
        await this.props.dispatcher.saveGitIgnore(
          this.props.repository,
          this.state.ignoreText
        )
      } catch (e) {
        log.error(
          `RepositorySettings: unable to save gitignore at ${this.props.repository.path}`,
          e
        )
        errors.push(`Failed saving the .gitignore file: ${e}`)
      }
    }

    // only update this if it will be different from what we have stored
    if (
      this.state.repositoryAccount?.login !==
      this.props.repositoryAccount?.login
    ) {
      await this.props.dispatcher.updateRepositoryAccount(
        this.props.repository,
        this.state.repositoryAccount &&
          this.state.repositoryAccount.login !== 'no-account'
          ? this.state.repositoryAccount
          : null
      )
    }

    // only update this if it will be different from what we have stored
    if (
      this.state.forkContributionTarget !==
      this.props.repository.workflowPreferences.forkContributionTarget
    ) {
      await this.props.dispatcher.updateRepositoryWorkflowPreferences(
        this.props.repository,
        {
          ...this.props.repository.workflowPreferences,
          forkContributionTarget: this.state.forkContributionTarget,
        }
      )
    }

    let shouldRefreshAuthor = false
    const gitLocationChanged =
      this.state.gitConfigLocation !== this.state.initialGitConfigLocation

    if (
      gitLocationChanged &&
      this.state.gitConfigLocation === GitConfigLocation.Global
    ) {
      // If it's now configured to use the global config, just delete the local
      // user info in this repository.
      await removeConfigValue(this.props.repository, 'user.name')
      await removeConfigValue(this.props.repository, 'user.email')

      shouldRefreshAuthor = true
    } else if (this.state.gitConfigLocation === GitConfigLocation.Local) {
      // Otherwise, update the local name and email if needed
      if (this.state.committerName !== this.state.initialCommitterName) {
        await setConfigValue(
          this.props.repository,
          'user.name',
          this.state.committerName
        )
        shouldRefreshAuthor = true
      }

      if (this.state.committerEmail !== this.state.initialCommitterEmail) {
        await setConfigValue(
          this.props.repository,
          'user.email',
          this.state.committerEmail
        )
        shouldRefreshAuthor = true
      }
    }

    if (shouldRefreshAuthor) {
      this.props.dispatcher.refreshAuthor(this.props.repository)
    }

    if (
      this.state.useDefaultEditor !==
        !this.props.repository.customEditorOverride ||
      this.state.selectedExternalEditor !==
        this.props.repository.customEditorOverride?.selectedExternalEditor ||
      this.state.useCustomEditor !==
        this.props.repository.customEditorOverride.useCustomEditor ||
      this.state.customEditor.path !==
        this.props.repository.customEditorOverride.customEditor?.path ||
      this.state.customEditor.arguments !==
        this.props.repository.customEditorOverride.customEditor.arguments
    ) {
      await this.props.dispatcher.updateRepositoryEditorOverride(
        this.props.repository,
        this.state.useDefaultEditor
          ? null
          : {
              selectedExternalEditor: this.state.selectedExternalEditor,
              useCustomEditor: this.state.useCustomEditor,
              customEditor: this.state.customEditor,
            }
      )
    }

    if (!errors.length) {
      this.props.onDismissed()
    } else {
      this.setState({ disabled: false, errors })
    }
  }

  private onRemoteUrlChanged = (url: string) => {
    const remote = this.props.remote

    if (!remote) {
      return
    }

    const newRemote = { ...remote, url }
    this.setState({ remote: newRemote })
  }

  private onIgnoreTextChanged = (text: string) => {
    this.setState({ ignoreText: text, ignoreTextHasChanged: true })
  }

  private onTabClicked = (index: number) => {
    this.setState({ selectedTab: index })
  }

  private onForkContributionTargetChanged = (
    forkContributionTarget: ForkContributionTarget
  ) => {
    this.setState({
      forkContributionTarget,
    })
  }

  private onDefaultBranchChanged = (branch: string) => {
    this.setState({ defaultBranch: branch })
  }

  private onSelectedAccountChanged = (account: Account) => {
    this.setState({ repositoryAccount: account })
  }

  private onGitConfigLocationChanged = (value: GitConfigLocation) => {
    this.setState({ gitConfigLocation: value })
  }

  private onCommitterNameChanged = (committerName: string) => {
    const errors = new Array<JSX.Element | string>()

    if (gitAuthorNameIsValid(committerName)) {
      this.setState({ saveDisabled: false })
    } else {
      this.setState({ saveDisabled: true })
      errors.push(InvalidGitAuthorNameMessage)
    }

    this.setState({ committerName, errors })
  }

  private onCommitterEmailChanged = (committerEmail: string) => {
    this.setState({ committerEmail })
  }

  private onUseDefaultEditorChanged = (useDefaultEditor: boolean) => {
    this.setState({ useDefaultEditor: useDefaultEditor })
  }

  private onSelectedEditorChanged = (selectedExternalEditor: string) => {
    this.setState({ selectedExternalEditor })
  }

  private onUseCustomEditorChanged = (useCustomEditor: boolean) => {
    this.setState({ useCustomEditor })
  }

  private onCustomEditorChanged = (customEditor: ICustomIntegration) => {
    this.setState({ customEditor })
  }
}
