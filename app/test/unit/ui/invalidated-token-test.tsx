import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as React from 'react'
import { InvalidatedToken } from '../../../src/ui/invalidated-token/invalidated-token'
import { Accounts } from '../../../src/ui/preferences/accounts'
import { Account } from '../../../src/models/account'
import { DialogStackContext } from '../../../src/ui/dialog/dialog'
import { render, screen, fireEvent, waitFor } from '../../helpers/ui/render'

const unexpectedProviderSignIns = {
  showBitbucketSignInDialog: () => assert.fail('Unexpected sign-in'),
  showGitLabSignInDialog: () => assert.fail('Unexpected sign-in'),
  showCodebergSignInDialog: () => assert.fail('Unexpected sign-in'),
  showGiteaSignInDialog: () => assert.fail('Unexpected sign-in'),
  showSelfHostedSignInDialog: () => assert.fail('Unexpected sign-in'),
}

describe('Session recovery dialog', () => {
  let view: ReturnType<typeof render> | undefined
  let restoreIpc: (() => void) | undefined
  beforeEach(async () => {
    const electron = await import('electron')
    const previousSend = electron.ipcRenderer.send
    electron.ipcRenderer.send = () => {}
    const showModal = Object.getOwnPropertyDescriptor(
      HTMLDialogElement.prototype,
      'showModal'
    )
    const close = Object.getOwnPropertyDescriptor(
      HTMLDialogElement.prototype,
      'close'
    )
    HTMLDialogElement.prototype.showModal = function () {
      this.open = true
    }
    HTMLDialogElement.prototype.close = function () {
      this.open = false
    }
    restoreIpc = () => {
      electron.ipcRenderer.send = previousSend
      for (const [key, descriptor] of [
        ['showModal', showModal],
        ['close', close],
      ] as const) {
        if (descriptor === undefined) {
          Reflect.deleteProperty(HTMLDialogElement.prototype, key)
        } else {
          Object.defineProperty(HTMLDialogElement.prototype, key, descriptor)
        }
      }
    }
  })
  afterEach(() => {
    view?.unmount()
    view = undefined
    restoreIpc?.()
  })
  for (const endpoint of [
    'https://api.github.com',
    'https://github.example.com/api/v3',
  ]) {
    it(`offers sign-in after signing out (${endpoint})`, () => {
      const actions: string[] = []
      const dispatcher = {
        showAccountSignInDialog: async (endpoint: string, login: string) => {
          actions.push(`${endpoint} ${login}`)
        },
        ...unexpectedProviderSignIns,
      }
      view = render(
        <InvalidatedToken
          account={
            new Account(
              'octocat',
              endpoint,
              endpoint === 'https://api.github.com' ? 'dotcom' : 'enterprise',
              '',
              [],
              '',
              1,
              'Octocat'
            )
          }
          dispatcher={dispatcher}
          onDismissed={() => actions.push('dismiss')}
        />
      )
      assert.ok(screen.getByText(/you have been signed out/))
      assert.ok(screen.getByText('octocat'))
      fireEvent.click(screen.getByRole('button', { name: 'Yes', hidden: true }))
      assert.deepEqual(actions, ['dismiss', `${endpoint} octocat`])
    })
  }

  it('dismisses sign-in while leaving the account signed out', async () => {
    let dismissed = 0
    let signIns = 0
    const account = new Account(
      'octocat',
      'https://api.github.com',
      'dotcom',
      '',
      [],
      '',
      1,
      'Octocat'
    )
    view = render(
      <DialogStackContext.Provider value={{ isTopMost: true }}>
        <InvalidatedToken
          account={account}
          dispatcher={{
            showAccountSignInDialog: () => assert.fail('Unexpected sign-in'),
            ...unexpectedProviderSignIns,
          }}
          onDismissed={() => dismissed++}
        />
      </DialogStackContext.Provider>
    )
    await waitFor(() => {
      fireEvent.click(screen.getByRole('button', { name: 'No', hidden: true }))
      assert.equal(dismissed, 1)
    })
    view.rerender(
      <Accounts
        accounts={[]}
        onDotComSignIn={() => signIns++}
        onEnterpriseSignIn={() => assert.fail('Unexpected Enterprise sign-in')}
        onBitbucketSignIn={() => assert.fail('Unexpected Bitbucket sign-in')}
        onGitLabSignIn={() => assert.fail('Unexpected GitLab sign-in')}
        onCodebergSignIn={() => assert.fail('Unexpected Codeberg sign-in')}
        onGiteaSignIn={() => assert.fail('Unexpected Gitea sign-in')}
        onSelfHostedSignIn={() => assert.fail('Unexpected self-hosted sign-in')}
        onLogout={() => assert.fail('Account should already be signed out')}
      />
    )
    assert.equal(screen.queryByText('Octocat'), null)
    fireEvent.click(
      screen.getByRole('button', { name: /sign into GitHub.com/i })
    )
    assert.equal(signIns, 1)
  })
})
