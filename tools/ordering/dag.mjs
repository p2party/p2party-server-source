import { createHash } from "node:crypto";
import { closeSync, openSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  checkSignature,
  checkVotes,
  digest,
  fields,
  fixed,
  hex,
  memberIndex,
  signSubject,
  u32,
} from "./committee.mjs";
import {
  signatureSuites,
  hasTransferHexLength,
} from "../../clients/evm/src/suites.ts";

import { executionSubject } from "./execution.mjs";

const PREFIX = Buffer.from("move/id", "ascii");
export function nativeMoveId(chainId, wire) {
  if (typeof wire !== "string" || !hasTransferHexLength(wire.length))
    throw Error("Invalid native transfer size");
  const bytes = fixed(wire, (wire.length - 2) / 2);
  const signer = signatureSuites.find((suite) => suite.id === bytes[114]);
  if (
    bytes[0] !== 1 ||
    bytes[1] !== 1 ||
    !bytes.subarray(2, 34).equals(fixed(chainId, 32)) ||
    !signer ||
    bytes.length !== 244 + signer.key + signer.signature ||
    !signatureSuites.some((suite) => suite.id === bytes[115])
  )
    throw Error("Wrong native transfer format or chain");
  return hex(
    createHash("sha512")
      .update(Buffer.from([PREFIX.length]))
      .update(PREFIX)
      .update(bytes)
      .digest(),
  );
}
export function vertexId(committee, header) {
  fields(header, ["committeeId", "round", "author", "parents", "moves"]);
  if (
    header.committeeId !== committee.committeeId ||
    !Number.isInteger(header.author) ||
    header.author < 0 ||
    header.author >= committee.operators.length ||
    header.round < 1
  )
    throw Error("Wrong vertex context");
  const encodedRound = u32(header.round);
  if (
    !Array.isArray(header.parents) ||
    header.parents.length > committee.operators.length ||
    (header.round === 1
      ? header.parents.length !== 0
      : header.parents.length < committee.quorum)
  )
    throw Error("Wrong parent count");
  if (
    !Array.isArray(header.moves) ||
    header.moves.length > 16 ||
    new Set(header.moves).size !== header.moves.length
  )
    throw Error("Invalid batch");
  const parents = header.parents.map((id, i) => {
    if (i && header.parents[i - 1] >= id)
      throw Error("Parents must be unique and sorted");
    return fixed(id, 64);
  });
  return hex(
    digest(
      "vertex",
      fixed(committee.committeeId, 64),
      encodedRound,
      u32(header.author),
      u32(parents.length),
      ...parents,
      u32(header.moves.length),
      ...header.moves.map((id) => fixed(id, 64)),
    ),
  );
}
function checkedProposal(committee, proposal) {
  fields(proposal, ["header", "signature", "wires"]);
  const id = vertexId(committee, proposal.header);
  if (
    !Array.isArray(proposal.wires) ||
    proposal.wires.length !== proposal.header.moves.length
  )
    throw Error("Incomplete vertex payload");
  for (let i = 0; i < proposal.wires.length; i++)
    if (
      nativeMoveId(committee.chainId, proposal.wires[i]) !==
      proposal.header.moves[i]
    )
      throw Error("Payload commitment mismatch");
  checkSignature(
    committee,
    "proposal",
    id,
    proposal.header.author,
    proposal.signature,
  );
  return id;
}
// A certificate authenticates storage and the one-vertex-per-author/round rule.
// Native authorization, spendability and deterministic rejection run at execution.
export function certifyVertex(committee, proposal, acks) {
  const id = checkedProposal(committee, proposal);
  if (!Array.isArray(acks) || acks.length > committee.operators.length)
    throw Error("Invalid acknowledgments");
  const votes = acks
    .map((a) => {
      fields(a, ["vertexId", "voter", "signature"]);
      if (a.vertexId !== id) throw Error("Vote for a different vertex");
      return { voter: a.voter, signature: a.signature };
    })
    .sort((a, b) => a.voter - b.voter);
  checkVotes(committee, "available", id, votes);
  return { proposal, votes };
}
export function anchorAuthor(committee, roundNumber) {
  if (!Number.isInteger(roundNumber) || roundNumber < 2 || roundNumber % 2)
    throw Error("Expected even anchor round");
  return (roundNumber / 2 - 1) % committee.operators.length;
}
const slot = (round, author) => round + "/" + author;
export class CertifiedDag {
  #blocks = new Map();
  #positions = new Map();
  #ordered = new Set();
  #seenMoves = new Set();
  #wires = [];
  #ends = new Map();
  #last = 0;
  constructor(committee) {
    this.committee = committee;
    Object.freeze(this);
  }
  get lastRound() {
    return this.#last;
  }
  get anchorIds() {
    return [...this.#ends.keys()];
  }
  // Materialize exactly the prefix associated with the locally ordered anchor.
  orderedWires(anchorId) {
    const end = this.#ends.get(anchorId);
    if (end === undefined) throw Error("Anchor is not committed in this DAG");
    return this.#wires.slice(0, end);
  }
  checkParents(header) {
    const authors = new Set();
    for (const id of header.parents) {
      const parent = this.#blocks.get(id);
      if (!parent) throw Error("Missing certified parent");
      if (parent.round !== header.round - 1 || authors.has(parent.author))
        throw Error("Parents must have distinct authors in preceding round");
      authors.add(parent.author);
    }
  }
  admit(cert, persist) {
    fields(cert, ["proposal", "votes"]);
    const committee = this.committee,
      id = checkedProposal(committee, cert.proposal),
      header = cert.proposal.header;
    checkVotes(committee, "available", id, cert.votes);
    this.checkParents(header);
    const position = slot(header.round, header.author);
    if (this.#positions.has(position) && this.#positions.get(position) !== id)
      throw Error("Conflicting certified vertex");
    if (this.#blocks.has(id)) return id;
    const block = {
      id,
      round: header.round,
      author: header.author,
      parents: [...header.parents],
      moves: [...header.moves],
      wires: [...cert.proposal.wires],
    };
    persist?.(id);
    this.#positions.set(position, id);
    this.#blocks.set(id, block);
    this.#decide(block);
    return id;
  }
  #closure(root) {
    const seen = new Set(),
      pending = [root];
    while (pending.length) {
      const id = pending.pop();
      if (seen.has(id) || this.#ordered.has(id)) continue;
      seen.add(id);
      pending.push(...this.#blocks.get(id).parents);
    }
    return seen;
  }
  #decide(vertex) {
    const committee = this.committee,
      round = vertex.round - 2;
    if (vertex.round % 2 || round < 2 || round <= this.#last) return;
    const leader = this.#positions.get(
      slot(round, anchorAuthor(committee, round)),
    );
    if (
      !leader ||
      vertex.parents.filter((id) =>
        this.#blocks.get(id).parents.includes(leader),
      ).length <
        committee.f + 1
    )
      return;
    // Bullshark PS, Algorithm 2: walk backwards from the *last linked* anchor.
    const anchors = [leader];
    let reachable = this.#closure(leader);
    for (
      let roundNumber = round - 2;
      roundNumber > this.#last;
      roundNumber -= 2
    ) {
      const previous = this.#positions.get(
        slot(roundNumber, anchorAuthor(committee, roundNumber)),
      );
      if (previous && reachable.has(previous)) {
        anchors.push(previous);
        reachable = this.#closure(previous);
      }
    }
    for (const id of anchors.reverse()) {
      const size = committee.operators.length;
      // Rotate first position within each round. The schedule is public and
      // deterministic, including when some of those positions are absent.
      const rank = (b) => (b.author - ((b.round - 1) % size) + size) % size;
      const ordered = [...this.#closure(id)]
        .map((k) => this.#blocks.get(k))
        .sort((a, b) => a.round - b.round || rank(a) - rank(b));
      for (const block of ordered) {
        this.#ordered.add(block.id);
        block.moves.forEach((move, i) => {
          if (!this.#seenMoves.has(move)) {
            this.#seenMoves.add(move);
            this.#wires.push(block.wires[i]);
          }
        });
      }
      this.#ends.set(id, this.#wires.length);
    }
    this.#last = round;
  }
}
export class Validator {
  #db;
  #key;
  #dag;
  constructor(committee, privateKey, path, { create = false } = {}) {
    this.committee = committee;
    this.index = memberIndex(committee, privateKey);
    this.#key = privateKey;
    if (create) closeSync(openSync(path, "wx", 0o600));
    else if (!statSync(path).isFile())
      throw Error("Expected existing vote journal");
    this.#db = new DatabaseSync(path);
    this.#dag = new CertifiedDag(committee);
    try {
      this.#db.exec("PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
      if (create) {
        this.#db.exec(
          `BEGIN IMMEDIATE;
           CREATE TABLE identity(committee TEXT NOT NULL, voter INTEGER NOT NULL);
           CREATE TABLE decisions(
             slot TEXT PRIMARY KEY,
             subject TEXT NOT NULL,
             data TEXT NOT NULL,
             signature TEXT NOT NULL
           );
           CREATE INDEX decision_subject ON decisions(subject);
           CREATE TABLE certs(id TEXT PRIMARY KEY, data TEXT NOT NULL);`,
        );
        this.#db
          .prepare("INSERT INTO identity VALUES(?,?)")
          .run(committee.committeeId, this.index);
        this.#db.exec("COMMIT");
      }
      const identity = this.#db.prepare("SELECT * FROM identity").get();
      if (
        identity.committee !== committee.committeeId ||
        identity.voter !== this.index
      )
        throw Error("Journal committee or voter mismatch");
      for (const row of this.#db
        .prepare("SELECT data FROM certs ORDER BY rowid")
        .iterate())
        this.#dag.admit(JSON.parse(row.data));
      Object.freeze(this);
    } catch (e) {
      this.#db.close();
      throw e;
    }
  }
  get anchorIds() {
    return this.#dag.anchorIds;
  }
  orderedWires(anchor) {
    return this.#dag.orderedWires(anchor);
  }
  storedProposal(id) {
    fixed(id, 64);
    const row = this.#db
      .prepare(
        "SELECT data FROM decisions WHERE subject=? AND slot LIKE 'available/%'",
      )
      .get(id);
    return row ? JSON.parse(row.data) : null;
  }
  certificate(id) {
    fixed(id, 64);
    const row = this.#db.prepare("SELECT data FROM certs WHERE id=?").get(id);
    return row ? JSON.parse(row.data) : null;
  }
  close() {
    this.#db.close();
  }
  #record(domain, key, subject, data) {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.#db
        .prepare("SELECT subject,signature FROM decisions WHERE slot=?")
        .get(key);
      if (prior && prior.subject !== subject)
        throw Error("Refusing conflicting vote in " + key);
      let signature = prior?.signature;
      if (!prior) {
        signature = signSubject(
          this.committee,
          domain,
          subject,
          this.index,
          this.#key,
        );
        this.#db
          .prepare("INSERT INTO decisions VALUES(?,?,?,?)")
          .run(key, subject, JSON.stringify(data), signature);
      }
      this.#db.exec("COMMIT");
      return signature;
    } catch (e) {
      this.#db.exec("ROLLBACK");
      throw e;
    }
  }
  propose(round, parents, wires) {
    if (!Array.isArray(wires) || wires.length > 16)
      throw Error("Invalid batch");
    const committee = this.committee;
    const header = {
      committeeId: committee.committeeId,
      round,
      author: this.index,
      parents: [...parents].sort(),
      moves: wires.map((w) => nativeMoveId(committee.chainId, w)),
    };
    const id = vertexId(committee, header);
    this.#dag.checkParents(header);
    return {
      header,
      signature: this.#record("proposal", "author/" + round, id, {
        header,
        wires,
      }),
      wires: [...wires],
    };
  }
  acknowledge(proposal) {
    const id = checkedProposal(this.committee, proposal),
      header = proposal.header;
    this.#dag.checkParents(header);
    const signature = this.#record(
      "available",
      "available/" + slot(header.round, header.author),
      id,
      proposal,
    );
    return { vertexId: id, voter: this.index, signature };
  }
  admit(cert) {
    return this.#dag.admit(cert, (id) => {
      this.#db
        .prepare("INSERT OR IGNORE INTO certs VALUES(?,?)")
        .run(id, JSON.stringify(cert));
    });
  }
  async attestExecution(anchorId, replay) {
    const ordered = this.#dag.orderedWires(anchorId);
    const state = await replay(ordered);
    fields(state, ["height", "logRoot", "stateRoot"]);
    const committee = this.committee;
    const checkpoint = {
      chainId: committee.chainId,
      genesisHash: committee.genesisHash,
      committeeId: committee.committeeId,
      anchorId,
      ...state,
    };
    const subject = executionSubject(committee, checkpoint);
    const signature = this.#record(
      "execution",
      "execution/" + anchorId,
      subject,
      checkpoint,
    );
    return { checkpoint, voter: this.index, signature };
  }
}
