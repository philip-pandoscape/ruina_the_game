import { currentAccount, devSignIn, Refused, type Account } from '../net/account';
import { WorldLink, type Welcome } from '../net/worldLink';
import { SignInScreen } from '../ui/signIn';

// Emberholm is played on the game server. Before the island loads: sign in (or make an account),
// then connect, and the server hands over your island and build. Automated tests (?test) and the
// training yard stay offline and never come here.
//
// ?as=name signs straight in as that name on a development server (DEV_LOGIN=1), making the
// account if it's new: for tests, and for playing several characters in different windows.

export interface Online {
  account: Account;
  link: WorldLink;
  welcome: Welcome;
  /** Whether the server's island has arrived yet (set up by the game once it's listening). */
  lifeLoaded?: () => boolean;
}

export async function goOnline(params: URLSearchParams): Promise<Online> {
  const screen = new SignInScreen();
  for (;;) {
    try {
      screen.wait('Reaching the game server…');
      let account = await currentAccount();
      let note = '';
      const as = params.get('as');
      if (as && account?.username.toLowerCase() !== as.toLowerCase()) {
        try {
          account = await devSignIn(as);
        } catch (e) {
          if (!(e instanceof Refused)) throw e;
          note = `?as: ${e.message}`;
        }
      }
      if (!account) account = await screen.ask(note);
      screen.wait(`Welcome, ${account.username}. Joining Emberholm…`);
      const { link, welcome } = await WorldLink.open();
      screen.close();
      return { account, link, welcome };
    } catch (e) {
      await screen.trouble(e instanceof Error ? e.message : String(e));
    }
  }
}
