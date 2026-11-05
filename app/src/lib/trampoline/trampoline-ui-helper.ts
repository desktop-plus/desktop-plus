import { Account } from '../../models/account'
import { IGitAccount } from '../../models/git-account'
import { deduceRepositoryType } from '../../models/github-repository'
import { PopupType } from '../../models/popup'
import { Dispatcher } from '../../ui/dispatcher'
import {
  findRegisteredEndpointForHost,
  tryGetHost,
} from '../endpoint-api-type-registry'
import { assertNever } from '../fatal-error'
import { SelfHostedApiType, SignInResult } from '../stores'

type PromptSSHSecretResponse = {
  readonly secret: string | undefined
  readonly storeSecret: boolean
}

class TrampolineUIHelper {
  // The dispatcher must be set before this helper can do anything
  private dispatcher!: Dispatcher

  public setDispatcher(dispatcher: Dispatcher) {
    this.dispatcher = dispatcher
  }

  public promptAddingSSHHost(
    host: string,
    ip: string,
    keyType: string,
    fingerprint: string
  ): Promise<boolean> {
    return new Promise(resolve => {
      this.dispatcher.showPopup({
        type: PopupType.AddSSHHost,
        host,
        ip,
        keyType,
        fingerprint,
        onSubmit: addHost => resolve(addHost),
      })
    })
  }

  public promptSSHKeyPassphrase(
    keyPath: string
  ): Promise<PromptSSHSecretResponse> {
    return new Promise(resolve => {
      this.dispatcher.showPopup({
        type: PopupType.SSHKeyPassphrase,
        keyPath,
        onSubmit: (passphrase, storePassphrase) =>
          resolve({ secret: passphrase, storeSecret: storePassphrase }),
      })
    })
  }

  public promptSSHUserPassword(
    username: string
  ): Promise<PromptSSHSecretResponse> {
    return new Promise(resolve => {
      this.dispatcher.showPopup({
        type: PopupType.SSHUserPassword,
        username,
        onSubmit: (password, storePassword) =>
          resolve({ secret: password, storeSecret: storePassword }),
      })
    })
  }

  public promptForGenericGitAuthentication(
    endpoint: string,
    username?: string
  ): Promise<IGitAccount | undefined> {
    return new Promise(resolve => {
      this.dispatcher.showPopup({
        type: PopupType.GenericGitAuthentication,
        remoteUrl: endpoint,
        username,
        onSubmit: (login: string, token: string) =>
          resolve({ login, token, endpoint }),
        onDismiss: () => resolve(undefined),
      })
    })
  }

  public promptForGitHubSignIn(endpoint: string): Promise<Account | undefined> {
    return new Promise<Account | undefined>(async resolve => {
      const cb = (result: SignInResult) => {
        resolve(result.kind === 'success' ? result.account : undefined)
        this.dispatcher.closePopup(PopupType.SignIn)
      }

      const repositoryType = deduceRepositoryType(endpoint)
      switch (repositoryType) {
        case 'github':
          const { hostname, origin } = new URL(endpoint)
          if (hostname === 'github.com') {
            this.dispatcher.beginDotComSignIn(cb)
          } else {
            this.dispatcher.beginEnterpriseSignIn(cb)
            await this.dispatcher.setSignInEndpoint(origin, true)
          }
          break
        case 'bitbucket':
          this.dispatcher.beginBitbucketSignIn(cb)
          break
        case 'gitlab':
        case 'forgejo':
        case 'gitea': {
          // A registered host is a self-hosted instance, so sign in to that
          // instance rather than to the provider's cloud offering.
          const registered = findRegisteredEndpointForHost(tryGetHost(endpoint))
          if (registered?.apiType === repositoryType) {
            this.dispatcher.beginSelfHostedSignIn(repositoryType, cb)
            await this.dispatcher.setSignInEndpoint(registered.webBaseUrl)
          } else {
            this.beginCloudSignIn(repositoryType, cb)
          }
          break
        }
        default:
          assertNever(repositoryType, `Unexpected repo type: ${repositoryType}`)
      }

      this.dispatcher.showPopup({
        type: PopupType.SignIn,
        isCredentialHelperSignIn: true,
        credentialHelperUrl: endpoint,
      })
    }).catch(e => {
      log.error(`Could not prompt for GitHub sign in`, e)
      return undefined
    })
  }

  /** Sign in to the cloud offering of a third-party provider. */
  private beginCloudSignIn(
    apiType: SelfHostedApiType,
    cb: (result: SignInResult) => void
  ) {
    switch (apiType) {
      case 'gitlab':
        this.dispatcher.beginGitLabSignIn(cb)
        break
      case 'forgejo':
        this.dispatcher.beginCodebergSignIn(cb)
        break
      case 'gitea':
        this.dispatcher.beginGiteaSignIn(cb)
        break
      default:
        assertNever(apiType, `Unexpected API type: ${apiType}`)
    }
  }
}

export const trampolineUIHelper = new TrampolineUIHelper()
