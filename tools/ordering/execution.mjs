import { checkVotes, digest, fields, fixed, hex } from "./committee.mjs";

export function executionSubject(committee, checkpoint) {
  fields(checkpoint, [
    "chainId",
    "genesisHash",
    "committeeId",
    "anchorId",
    "height",
    "logRoot",
    "stateRoot",
  ]);
  if (
    checkpoint.chainId !== committee.chainId ||
    checkpoint.genesisHash !== committee.genesisHash ||
    checkpoint.committeeId !== committee.committeeId
  )
    throw Error("Execution context differs from committee");
  if (
    typeof checkpoint.height !== "string" ||
    !/^0x(?:0|[1-9a-f][0-9a-f]{0,15})$/.test(checkpoint.height) ||
    BigInt(checkpoint.height) > 0x7fffffffffffffffn
  )
    throw Error("Invalid execution height");
  const height = Buffer.alloc(8);
  height.writeBigUInt64BE(BigInt(checkpoint.height));
  return hex(
    digest(
      "executed-state",
      fixed(committee.committeeId, 64),
      fixed(committee.chainId, 32),
      fixed(committee.genesisHash, 32),
      fixed(checkpoint.anchorId, 64),
      height,
      fixed(checkpoint.logRoot, 64),
      fixed(checkpoint.stateRoot, 64),
    ),
  );
}
export function attestExecution(validator, anchorId, replay) {
  return validator.attestExecution(anchorId, replay);
}
export function collectExecution(committee, attestations) {
  if (
    !Array.isArray(attestations) ||
    attestations.length < committee.quorum ||
    attestations.length > committee.operators.length
  )
    throw Error("Invalid execution quorum");
  const checkpoint = { ...attestations[0].checkpoint };
  const subject = executionSubject(committee, checkpoint);
  const votes = attestations
    .map((item) => {
      fields(item, ["checkpoint", "voter", "signature"]);
      if (executionSubject(committee, item.checkpoint) !== subject)
        throw Error("Inconsistent execution checkpoint");
      return { voter: item.voter, signature: item.signature };
    })
    .sort((a, b) => a.voter - b.voter);
  checkVotes(committee, "execution", subject, votes);
  return { checkpoint, votes };
}
export function verifyExecutionCertificate(committee, expected, cert) {
  fields(cert, ["checkpoint", "votes"]);
  const subject = executionSubject(committee, cert.checkpoint);
  if (executionSubject(committee, expected) !== subject)
    throw Error("Unexpected executed state");
  checkVotes(committee, "execution", subject, cert.votes);
  return { ...cert.checkpoint };
}
