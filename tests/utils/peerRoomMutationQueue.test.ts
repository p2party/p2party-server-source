import { expect, test } from "bun:test";
import { admissionLimits } from "../../src/utils/admission";
import {
  runMembershipMutation,
  runPeerRoomMutation,
} from "../../src/utils/peerRoomMutationQueue";

test("room locks have their own bound and peer locks keep theirs", async () => {
  let open = () => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const settle = (mutation: Promise<unknown>) =>
    mutation.then(
      () => "served",
      (error: Error) => error.message,
    );

  // The same string as a peer key and as a room key: separate queues.
  const key = "00000000-0000-4000-8000-000000000001";
  const peer = Array.from({ length: 9 }, () =>
    settle(runPeerRoomMutation(key, () => gate)),
  );
  const room = Array.from({ length: admissionLimits.peersPerRoom + 1 }, () =>
    settle(runMembershipMutation("room", key, () => gate)),
  );
  open();

  const peerResults = await Promise.all(peer);
  expect(peerResults.slice(0, 8)).toEqual(Array(8).fill("served"));
  expect(peerResults[8]).toBe("Too many pending room mutations for this peer");

  const roomResults = await Promise.all(room);
  // Every member of a full room can have a rejoin queued at once.
  expect(roomResults.slice(0, admissionLimits.peersPerRoom)).toEqual(
    Array(admissionLimits.peersPerRoom).fill("served"),
  );
  expect(roomResults[admissionLimits.peersPerRoom]).toBe(
    "Too many pending room mutations for this room",
  );
});
