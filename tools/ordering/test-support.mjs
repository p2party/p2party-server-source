// Isolated smoke-test committee. Keys are independently generated on one host.
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeCommittee, memberIndex } from "./committee.mjs";
import { Validator, certifyVertex, vertexId } from "./dag.mjs";
export function localCommittee({ chainId, genesisHash, epoch = 0 }) {
  const initial = Array.from({ length: 4 }, () =>
    generateKeyPairSync("ml-dsa-65"),
  );
  const committee = makeCommittee({
    version: 1,
    chainId,
    genesisHash,
    epoch,
    operators: initial.map((p) =>
      p.publicKey.export({ type: "spki", format: "pem" }),
    ),
  });
  return localValidators(
    committee,
    initial.map((p) => p.privateKey),
  );
}
export function localValidators(committee, privateKeys) {
  const keys = [...privateKeys].sort(
    (a, b) => memberIndex(committee, a) - memberIndex(committee, b),
  );
  const dir = mkdtempSync(join(tmpdir(), "p2party-dag-"));
  const paths = keys.map((_, i) => join(dir, i + ".sqlite"));
  const validators = keys.map(
    (key, i) => new Validator(committee, key, paths[i], { create: true }),
  );
  const rounds = new Map();
  /**
   * @param {number} number
   * @param {{wires?: (author: number) => string[], parents?: (author: number) => string[], authors?: number[], voters?: number[]}} [options]
   */
  function round(
    number,
    {
      wires = () => [],
      parents = () =>
        number === 1
          ? []
          : rounds
              .get(number - 1)
              .map((c) => vertexId(committee, c.proposal.header)),
      authors = [0, 1, 2],
      voters = [0, 1, 2],
    } = {},
  ) {
    const certs = authors.map((i) => {
      const p = validators[i].propose(number, parents(i), wires(i));
      return certifyVertex(
        committee,
        p,
        voters.map((j) => validators[j].acknowledge(p)),
      );
    });
    for (const v of validators) for (const cert of certs) v.admit(cert);
    rounds.set(number, certs);
    return certs;
  }
  function close() {
    try {
      for (const v of validators) v.close();
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  }
  return { committee, keys, validators, paths, round, close };
}
