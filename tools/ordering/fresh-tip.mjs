// A response binds an independently generated one-use challenge to the latest
// locally committed anchor. A collected checkpoint speaks as of the read.
import { randomBytes } from "node:crypto";
import {
  checkSignature,
  checkVotes,
  digest,
  fields,
  fixed,
  hex,
  signSubject,
  u32,
} from "./committee.mjs";
import {
  collectExecution,
  executionSubject,
  verifyExecutionCertificate,
} from "./execution.mjs";
export const newChallenge = () => hex(randomBytes(32));
function subject(committee, nonce, round, checkpoint) {
  if (!Number.isInteger(round) || round < 2 || round % 2)
    throw Error("Invalid anchor round");
  return hex(
    digest(
      "fresh-tip",
      fixed(nonce, 32),
      u32(round),
      fixed(executionSubject(committee, checkpoint), 64),
    ),
  );
}
export function signTip(committee, key, voter, nonce, round, checkpoint) {
  return {
    nonce,
    round,
    checkpoint,
    voter,
    signature: signSubject(
      committee,
      "tip",
      subject(committee, nonce, round, checkpoint),
      voter,
      key,
    ),
  };
}
export function verifyFreshTip(committee, nonce, replies, cert, previous) {
  if (
    !Array.isArray(replies) ||
    !replies.length ||
    replies.length > committee.operators.length
  )
    throw Error("Invalid responses");
  const { checkpoint, round } = replies[0];
  const expected = subject(committee, nonce, round, checkpoint);
  const votes = replies
    .map((r) => {
      fields(r, ["nonce", "round", "checkpoint", "voter", "signature"]);
      if (
        r.nonce !== nonce ||
        subject(committee, r.nonce, r.round, r.checkpoint) !== expected
      )
        throw Error("Inconsistent fresh checkpoint responses");
      return { voter: r.voter, signature: r.signature };
    })
    .sort((a, b) => a.voter - b.voter);
  checkVotes(committee, "tip", expected, votes);
  verifyExecutionCertificate(committee, checkpoint, cert);
  if (
    previous &&
    (previous.checkpoint.committeeId !== committee.committeeId ||
      round < previous.round ||
      BigInt(checkpoint.height) < BigInt(previous.checkpoint.height) ||
      (checkpoint.height === previous.checkpoint.height &&
        (checkpoint.logRoot !== previous.checkpoint.logRoot ||
          checkpoint.stateRoot !== previous.checkpoint.stateRoot)) ||
      (round === previous.round &&
        executionSubject(committee, previous.checkpoint) !==
          executionSubject(committee, checkpoint)))
  )
    throw Error("Checkpoint conflicts with saved pin");
  return { round, checkpoint: { ...checkpoint } };
}

// readPeer(index, nonce, signal) must use the caller's pinned endpoints and
// return that peer's signed tip and execution attestation. The deadline covers
// the entire read. Keep the last verified pin when a quorum is unreachable.
export async function readFreshTip(committee, readPeer, previous) {
  const nonce = newChallenge();
  const deadline = AbortSignal.timeout(5000);
  const controller = new AbortController();
  const signal = AbortSignal.any([deadline, controller.signal]);
  const groups = new Map();
  try {
    return await new Promise((resolve, reject) => {
      let remaining = committee.operators.length;
      deadline.addEventListener(
        "abort",
        () => reject(Error("Fresh checkpoint timed out")),
        { once: true },
      );
      committee.operators.forEach(async (_, index) => {
        try {
          const { tip, attestation } = await readPeer(index, nonce, signal);
          if (
            signal.aborted ||
            tip.voter !== index ||
            attestation.voter !== index ||
            tip.nonce !== nonce
          )
            return;
          const id = subject(committee, nonce, tip.round, tip.checkpoint);
          checkSignature(committee, "tip", id, index, tip.signature);
          const execution = executionSubject(committee, tip.checkpoint);
          if (executionSubject(committee, attestation.checkpoint) !== execution)
            return;
          checkSignature(
            committee,
            "execution",
            execution,
            index,
            attestation.signature,
          );
          if (!groups.has(id)) groups.set(id, []);
          const group = groups.get(id);
          group.push({ tip, attestation });
          const cert = collectExecution(
            committee,
            group.map((p) => p.attestation),
          );
          const pin = verifyFreshTip(
            committee,
            nonce,
            group.map((p) => p.tip),
            cert,
            previous,
          );
          resolve({ pin, certificate: cert });
        } catch {
          /* Only a verified, matching quorum can answer this read. */
        } finally {
          if (--remaining === 0)
            reject(Error("No matching fresh checkpoint quorum"));
        }
      });
    });
  } finally {
    controller.abort();
  }
}
