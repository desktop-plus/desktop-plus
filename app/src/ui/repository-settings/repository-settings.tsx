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
  getUpdateBranchStrategy,
  isRepositoryWithForkedGitHubRepository,
} from '../../models/repository'
import { Dialog, DialogContent, DialogError, DialogFooter } from '../dialog'
import { NoRemote } from './no-remote'
import { readGitIgnoreAtRoot } from '../../lib/git'
import { OkCancelButtonGroup } from '../dialog/ok-cancel-button-group'
import { ForkSettings } from './fork-settings'
import { ForkContributionTarget } from '../../models/workflow-preferences'
import { GitConfigLocation, GitConfig } from './git-config'
import {
  getConfigValue,
  getGlobalConfigValue,
  getConfigValueWithOrigin,
  IConfigValueOrigin,
} from '../../lib/git/config'
import {
  gitAuthorNameIsValid,
  InvalidGitAuthorNameMessage,
} from '../lib/identifier-rules'
import { Account, isSameAccount } from '../../models/account'
import { Octicon } from '../octicons'
import * as octicons from '../octicons/octicons.generated'
import { Integrations } from './integrations'
import {
  ICustomIntegration,
  TargetPathArgument,
} from '../../lib/custom-integration'
import { getAvailableEditors } from '../../lib/editors/lookup'
import { UpdateBranchStrategy } from '../../lib/update-branch-strategy'
import { EditorOverride } from '../../models/editor-override'
import { Select } from '../lib/select'

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
  readonly updateBranchStrategy: UpdateBranchStrategy
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
  readonly nameOrigin: IConfigValueOrigin | null
  readonly emailOrigin: IConfigValueOrigin | null
  readonly availableEditors: ReadonlyArray<string>
  readonly useDefaultEditor: boolean
  readonly selectedExternalEditor: string | null
  readonly useCustomEditor: boolean
  readonly customEditor: ICustomIntegration
  readonly useSystemDefaultProgram: boolean
  readonly selectedLogin?: string | null
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
      updateBranchStrategy: getUpdateBranchStrategy(props.repository),
      committerName: '',
      committerEmail: '',
      globalCommitterName: '',
      globalCommitterEmail: '',
      initialGitConfigLocation: GitConfigLocation.Global,
      initialCommitterName: null,
      initialCommitterEmail: null,
      isLoadingGitConfig: true,
      nameOrigin: null,
      emailOrigin: null,
      availableEditors: [],
      useDefaultEditor: !props.repository.customEditorOverride,
      selectedExternalEditor:
        props.repository.customEditorOverride?.selectedExternalEditor ?? null,
      useCustomEditor:
        props.repository.customEditorOverride?.useCustomEditor || false,
      customEditor: props.repository.customEditorOverride?.customEditor ?? {
        path: '',
        arguments: TargetPathArgument,
      },
      useSystemDefaultProgram:
        props.repository.customEditorOverride?.useSystemDefaultProgram ?? false,
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

    let nameOrigin: IConfigValueOrigin | null = null
    let emailOrigin: IConfigValueOrigin | null = null
    try {
      ;[nameOrigin, emailOrigin] = await Promise.all([
        getConfigValueWithOrigin(this.props.repository, 'user.name'),
        getConfigValueWithOrigin(this.props.repository, 'user.email'),
      ])
    } catch (e) {
      log.warn('Failed to get config value origins', e)
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
      nameOrigin,
      emailOrigin,
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
        return (
          <DialogContent>
            {remote ? (
              <Remote
                remote={remote}
                repository={this.props.repository}
                defaultBranch={this.state.defaultBranch}
                onRemoteUrlChanged={this.onRemoteUrlChanged}
                onDefaultBranchChanged={this.onDefaultBranchChanged}
              />
            ) : (
              <NoRemote onPublish={this.onPublish} />
            )}
            {this.renderAccount()}
          </DialogContent>
        )
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
            account={this.selectedAccount}
            gitConfigLocation={this.state.gitConfigLocation}
            updateBranchStrategy={this.state.updateBranchStrategy}
            onGitConfigLocationChanged={this.onGitConfigLocationChanged}
            onUpdateBranchStrategyChanged={this.onUpdateBranchStrategyChanged}
            name={this.state.committerName}
            email={this.state.committerEmail}
            globalName={this.state.globalCommitterName}
            globalEmail={this.state.globalCommitterEmail}
            onNameChanged={this.onCommitterNameChanged}
            onEmailChanged={this.onCommitterEmailChanged}
            isLoadingGitConfig={this.state.isLoadingGitConfig}
            nameOrigin={this.state.nameOrigin}
            emailOrigin={this.state.emailOrigin}
            repositoryPath={this.props.repository.path}
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
            useSystemDefaultProgram={this.state.useSystemDefaultProgram}
            onUseSystemDefaultProgramChanged={
              this.onUseSystemDefaultProgramChanged
            }
          />
        )
      }

      default:
        return assertNever(tab, `Unknown tab type: ${tab}`)
    }
  }

  private get selectedLogin() {
    return this.state.selectedLogin === undefined
      ? this.props.repository.login
      : this.state.selectedLogin
  }

  private get selectedAccount() {
    const endpoint = this.props.repository.gitHubRepository?.endpoint
    const login = this.selectedLogin
    return endpoint === undefined
      ? this.props.repositoryAccount
      : this.props.accounts.find(
          a => login !== null && isSameAccount(a, { endpoint, login })
        ) ?? null
  }

  private renderAccount() {
    const endpoint = this.props.repository.gitHubRepository?.endpoint
    if (endpoint === undefined) {
      return null
    }

    const accounts = this.props.accounts.filter(a => a.endpoint === endpoint)
    const login = this.selectedLogin
    const signedOut = login !== null && this.selectedAccount === null

    return (
      <div className="repository-account">
        <Select
          label="Account"
          value={this.selectedAccount?.login ?? login ?? ''}
          onChange={this.onAccountChanged}
        >
          <option value="">None (unassigned)</option>
          {signedOut && (
            <option value={login ?? ''} disabled={true}>
              @{login} (signed out)
            </option>
          )}
          {accounts.map(account => (
            <option key={account.login} value={account.login}>
              @{account.login}
            </option>
          ))}
        </Select>
        <p className="repository-account-description">
          The account used for GitHub API requests and HTTPS authentication.
          This does not change your Git author name or email.
        </p>
      </div>
    )
  }

  private onAccountChanged = (event: React.FormEvent<HTMLSelectElement>) => {
    this.setState({ selectedLogin: event.currentTarget.value || null })
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
    // Changing the account replaces the repository, and setting the remote
    // URL must refresh the GitHub association for the replacement.
    let repository = this.props.repository

    if (
      repository.gitHubRepository !== null &&
      this.state.selectedLogin !== undefined &&
      this.state.selectedLogin !== repository.login
    ) {
      try {
        repository = await this.props.dispatcher.updateRepositoryAccount(
          repository,
          this.state.selectedLogin
        )
      } catch (e) {
        errors.push(`Failed saving the repository account: ${e}`)
      }
    }

    if (this.state.remote && this.props.remote) {
      const trimmedUrl = this.state.remote.url.trim()

      if (trimmedUrl !== this.props.remote.url) {
        try {
          await this.props.dispatcher.setRemoteURL(
            repository,
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
          repository,
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
      this.state.forkContributionTarget !==
        this.props.repository.workflowPreferences.forkContributionTarget ||
      this.state.updateBranchStrategy !==
        getUpdateBranchStrategy(this.props.repository)
    ) {
      await this.props.dispatcher.updateRepositoryWorkflowPreferences(
        this.props.repository,
        {
          ...this.props.repository.workflowPreferences,
          forkContributionTarget: this.state.forkContributionTarget,
          updateBranchStrategy: this.state.updateBranchStrategy,
        }
      )
    }

    let shouldRefreshAuthor = false
    const gitLocationChanged =
      this.state.gitConfigLocation !== this.state.initialGitConfigLocation

    try {
      if (
        gitLocationChanged &&
        this.state.gitConfigLocation === GitConfigLocation.Global
      ) {
        // If it's now configured to use the global config, just delete the local
        // user info in this repository.
        shouldRefreshAuthor = true
        await this.props.dispatcher.updateRepositoryCommitter(
          this.props.repository,
          null,
          null
        )
      } else if (this.state.gitConfigLocation === GitConfigLocation.Local) {
        // Otherwise, update the local name and email if needed
        const name =
          this.state.committerName !== this.state.initialCommitterName
            ? this.state.committerName
            : undefined
        const email =
          this.state.committerEmail !== this.state.initialCommitterEmail
            ? this.state.committerEmail
            : undefined
        if (name !== undefined || email !== undefined) {
          shouldRefreshAuthor = true
          await this.props.dispatcher.updateRepositoryCommitter(
            this.props.repository,
            name,
            email
          )
        }
      }
    } catch (error) {
      log.error(
        `RepositorySettings: unable to update Git identity at ${this.props.repository.path}`,
        error
      )
      errors.push(`Failed updating Git identity: ${error}`)
    }

    if (shouldRefreshAuthor) {
      this.props.dispatcher.refreshAuthor(this.props.repository)
    }

    const newEditorOverride: EditorOverride | null = this.state.useDefaultEditor
      ? null
      : {
          selectedExternalEditor: this.state.selectedExternalEditor,
          useCustomEditor: this.state.useCustomEditor,
          customEditor: this.state.customEditor,
          useSystemDefaultProgram: this.state.useSystemDefaultProgram,
        }
    if (
      hasEditorOverrideChanged(
        this.props.repository.customEditorOverride,
        newEditorOverride
      )
    ) {
      await this.props.dispatcher.updateRepositoryEditorOverride(
        repository,
        newEditorOverride
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

  private onGitConfigLocationChanged = (value: GitConfigLocation) => {
    this.setState({ gitConfigLocation: value })
  }

  private onUpdateBranchStrategyChanged = (value: UpdateBranchStrategy) => {
    this.setState({ updateBranchStrategy: value })
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

  private onUseSystemDefaultProgramChanged = (
    useSystemDefaultProgram: boolean
  ) => {
    this.setState({ useSystemDefaultProgram })
  }
}

function hasEditorOverrideChanged(
  previous: EditorOverride | null,
  next: EditorOverride | null
): boolean {
  if (previous === null || next === null) {
    return previous !== next
  }

  return (
    previous.selectedExternalEditor !== next.selectedExternalEditor ||
    previous.useCustomEditor !== next.useCustomEditor ||
    previous.customEditor?.path !== next.customEditor?.path ||
    previous.customEditor?.arguments !== next.customEditor?.arguments ||
    (previous.useSystemDefaultProgram ?? false) !==
      (next.useSystemDefaultProgram ?? false)
  )
}
