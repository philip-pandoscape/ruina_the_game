import { currentAccount, devSignIn, listCharacters, Refused, type Account, type CharacterInfo } from '../net/account';
import { WorldLink, type Welcome } from '../net/worldLink';
import { CharacterSelect } from '../ui/characterSelect';
import { SignInScreen } from '../ui/signIn';
import { splash } from '../ui/splash';
import { playingAs, takeResume } from './resume';

// Emberholm is played on the game server. The front door, on the title screen (src/ui/splash.ts):
// sign in (or make an account), choose a character on the character select screen (each has an
// island of its own), then connect, and the server hands over that character's island and build.
// Automated tests (?test) and the training yard stay offline and never come here.
//
// Straight into the world, without the select screen:
//   ?as=name   signs in as that name on a development server (DEV_LOGIN=1), making the account if
//              it's new, and plays the character it played last: for tests, and for playing
//              several characters in different windows
//   a reload   of a tab that was in the world (the game updating itself, or F5): src/app/resume.ts

export interface Online {
  account: Account;
  link: WorldLink;
  welcome: Welcome;
  /** Whether the server's island has arrived yet (set up by the game once it's listening). */
  lifeLoaded?: () => boolean;
}

/** The character played most recently. */
const lastPlayed = (list: CharacterInfo[]) => [...list].sort((a, b) => (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0) || a.id - b.id)[0] ?? null;

export async function goOnline(params: URLSearchParams): Promise<Online> {
  const screen = new SignInScreen();
  const as = params.get('as');
  // Straight in, the first time round: a dev sign-in, or a reload of a tab that was in the world.
  let resume = takeResume();
  let straight = !!as || resume !== null;
  let entering: CharacterInfo | null = null;
  for (;;) {
    try {
      screen.wait('Reaching the Game Server…');
      let account = await currentAccount();
      splash?.step('server');
      let note = '';
      if (as && straight && account?.username.toLowerCase() !== as.toLowerCase()) {
        try {
          account = await devSignIn(as);
        } catch (e) {
          if (!(e instanceof Refused)) throw e;
          note = `?as: ${e.message}`;
          straight = false;
        }
      }
      if (!account) {
        account = await screen.ask(note);
        straight = false;
      }
      screen.wait('Gathering Your Characters…');
      const { characters, max } = await listCharacters();
      screen.clear();
      let pick = straight ? (characters.find((c) => c.id === resume) ?? (as ? lastPlayed(characters) : null)) : null;
      straight = false;
      resume = null;
      if (!pick) {
        const choice = await CharacterSelect.show(account, characters, max);
        // Signed out: back to signing in.
        if ('signedOut' in choice) continue;
        pick = choice.enter;
      }
      entering = pick;
      splash?.setMode('entering');
      screen.wait(`Entering Emberholm as ${pick.name}…`);
      splash?.toward('joined', 4);
      const { link, welcome } = await WorldLink.open(pick.id);
      splash?.step('joined');
      screen.close();
      playingAs(welcome.character.id);
      return { account, link, welcome };
    } catch (e) {
      // On the way in with someone: once the server answers, in with them again.
      if (entering) {
        resume = entering.id;
        straight = true;
      }
      splash?.setMode('title');
      await screen.trouble(e instanceof Error ? e.message : String(e));
    }
  }
}
