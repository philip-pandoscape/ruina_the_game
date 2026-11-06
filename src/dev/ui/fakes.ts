import type { Challenges, TableLink, TableView } from '../../ui/minigames/tables';
import type { PartyInviteView, PartyLink, PartyView } from '../../ui/party/partyUI';

// The world connection as the mini-game and party windows see it (they declare what they read of it
// and ask of it: TableLink, PartyLink), made up for the UI gallery: they show what it holds, and
// what they ask of it is kept for a test to look at, going nowhere. Its clocks stand still (`hold`,
// every frame), so a countdown shows the time made up for as long as it is looked at.

/** A table, challenges and what was asked of them, for the mini-game windows. */
export class MadeUpTables implements TableLink {
  table: TableView | null = null;
  tableHeard = performance.now();
  challenges: Challenges = { sent: null, waiting: null };
  challengesHeard = performance.now();
  onTable: ((t: TableView | null) => void) | null = null;
  onChallenges: ((c: Challenges) => void) | null = null;
  /** What the windows asked, in order. */
  readonly asked: Array<Record<string, unknown>> = [];

  /** Sits you at `t`, as the server's word on your table would. */
  setTable(t: TableView | null): void {
    this.table = t;
    this.tableHeard = performance.now();
    this.onTable?.(t);
  }

  /** Your challenge out and the one asking you, as the server's word on them would. */
  setChallenges(c: Challenges): void {
    this.challenges = c;
    this.challengesHeard = performance.now();
    this.onChallenges?.(c);
  }

  /** The clocks stand still: what the windows were told, they were told just now. */
  hold(): void {
    this.tableHeard = this.challengesHeard = performance.now();
  }

  challenge(to: number, game: string, stake: number): boolean {
    this.asked.push({ challenge: { to, game, stake } });
    return true;
  }

  withdraw(): boolean {
    this.asked.push({ withdraw: true });
    return true;
  }

  answer(from: number, accept: boolean): boolean {
    this.asked.push({ answer: { from, accept } });
    return true;
  }

  move(table: number, m: Record<string, unknown>): boolean {
    this.asked.push({ move: { table, m } });
    return true;
  }

  concede(table: number): boolean {
    this.asked.push({ concede: table });
    return true;
  }
}

/** A party, an invitation and the others' health, for the party windows. */
export class MadeUpParty implements PartyLink {
  party: PartyView | null = null;
  partyHeard = performance.now();
  invite: PartyInviteView | null = null;
  inviteHeard = performance.now();
  onParty: ((p: PartyView | null) => void) | null = null;
  onInvite: ((i: PartyInviteView | null) => void) | null = null;
  readonly peers = new Map<number, { p: Record<string, unknown> }>();
  /** What the windows asked, in order. */
  readonly asked: Array<Record<string, unknown>> = [];

  setParty(p: PartyView | null): void {
    this.party = p;
    this.partyHeard = performance.now();
    this.onParty?.(p);
  }

  setInvite(i: PartyInviteView | null): void {
    this.invite = i;
    this.inviteHeard = performance.now();
    this.onInvite?.(i);
  }

  /** The clocks stand still: what the windows were told, they were told just now. */
  hold(): void {
    this.partyHeard = this.inviteHeard = performance.now();
  }

  partyInvite(who: { to: number } | { name: string }): boolean {
    this.asked.push({ invite: who });
    return true;
  }

  partyAnswer(from: number, accept: boolean): boolean {
    this.asked.push({ answer: { from, accept } });
    return true;
  }

  partyLeave(): boolean {
    this.asked.push({ leave: true });
    return true;
  }

  partyKick(id: number): boolean {
    this.asked.push({ kick: id });
    return true;
  }

  partyLead(id: number): boolean {
    this.asked.push({ lead: id });
    return true;
  }
}
