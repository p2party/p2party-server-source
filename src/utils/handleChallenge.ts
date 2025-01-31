import { PrismaClient } from "@prisma/client";
import ondemos from "@ondemos/core";
import crypto from "crypto";

// import { convertHexToPem } from "../utils/convertBinaryToPEM.js";

import type { P2PartyWSClient } from "../wsServer.js";
import type {
  WebSocketMessageError,
  WebSocketMessageSuccessfulChallenge,
} from "../utils/interfaces.js";

const prisma = new PrismaClient();

const handleChallenge = async (
  fromPeerId: string,
  ws: P2PartyWSClient,
  challenge: string,
  signature: string,
) => {
  try {
    let fromPeerPublicKey = "";
    try {
      const fromPeer = await prisma.peer.findUnique({
        where: { id: fromPeerId },
      });

      if (!fromPeer) {
        await prisma.$disconnect();

        ws.send(
          JSON.stringify({
            type: "error",
            fromAction: "sendChallengeResponse",
            error: {
              message:
                "Challenge response was sent from peer with id " +
                fromPeerId +
                " who does not exist",
            },
          } as WebSocketMessageError),
        );

        ws.terminate();

        return;
      }

      fromPeerPublicKey = fromPeer.publicKey;
    } catch (error) {
      await prisma.$disconnect();

      ws.send(
        JSON.stringify({
          type: "error",
          fromAction: "sendChallengeResponse",
          error: {
            message:
              "Challenge response was sent from peer with id " +
              fromPeerId +
              " who does not exist",
          },
        } as WebSocketMessageError),
      );

      ws.terminate();

      return;
    }

    let correspondingChallengeId = "";
    try {
      const correspondingChallenge = await prisma.challenge.findUnique({
        where: { nonce: challenge },
        include: {
          peer: true,
        },
      });

      if (!correspondingChallenge) {
        await prisma.$disconnect();

        ws.send(
          JSON.stringify({
            type: "error",
            fromAction: "sendChallengeResponse",
            error: {
              message:
                "Challenge " +
                challenge +
                " does not correspond to peer with id " +
                fromPeerId,
            },
          } as WebSocketMessageError),
        );

        ws.terminate();

        return;
      }

      correspondingChallengeId = correspondingChallenge.id;

      if (correspondingChallenge.peer.id !== fromPeerId) {
        await prisma.$disconnect();

        ws.send(
          JSON.stringify({
            type: "error",
            fromAction: "sendChallengeResponse",
            error: {
              message:
                "Challenge " +
                challenge +
                " does not correspond to peer with id " +
                fromPeerId,
            },
          } as WebSocketMessageError),
        );

        ws.terminate();

        return;
      }
    } catch (error) {
      await prisma.$disconnect();

      ws.send(
        JSON.stringify({
          type: "error",
          fromAction: "sendChallengeResponse",
          error: {
            message: "Challenge " + challenge + " does not exist",
          },
        } as WebSocketMessageError),
      );

      ws.terminate();

      return;
    }

    const nonce = Uint8Array.from(
      challenge.match(/.{1,2}/g)!.map((byte: string) => parseInt(byte, 16)),
    );

    const sig = Uint8Array.from(
      signature
        // .substring(2)
        .match(/.{1,2}/g)!
        .map((byte: string) => parseInt(byte, 16)),
    );

    const pk = Uint8Array.from(
      fromPeerPublicKey
        .match(/.{1,2}/g)!
        .map((byte: string) => parseInt(byte, 16)),
    );

    const verification = await ondemos.verify(nonce, sig, pk);

    // const key = convertHexToPem(fromPeerPublicKey);
    // const publicKey = crypto.createPublicKey({
    //   key,
    //   format: "pem",
    //   type: "spki",
    // });

    // const verification = crypto.verify(
    //   "RSA-SHA256",
    //   nonce, // new Uint8Array(Buffer.from(nonce)),
    //   {
    //     key: publicKey,
    //     padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    //   },
    //   sig, // new Uint8Array(Buffer.from(sig)),
    // );

    // Convert Uint8Array to hex strings to pass to the Node.js child process
    // const nonceHex = Buffer.from(nonce).toString("hex");
    // const sigHex = Buffer.from(sig).toString("hex");
    // const publicKeyPem = convertHexToPem(fromPeerPublicKey); // Assuming this is already in hex format
    // const process = Bun.spawn({
    //   cmd: [
    //     "node",
    //     "scripts/verifySignature.js",
    //     nonceHex,
    //     sigHex,
    //     publicKeyPem,
    //   ],
    //   stdout: "pipe",
    //   stderr: "pipe",
    // });
    // // Capture the output from the Node.js script
    // const output = await new Response(process.stdout).text();
    // const errorOutput = await new Response(process.stderr).text();
    // if (errorOutput) {
    //   console.error("Error from Node.js script:", errorOutput);
    // }
    // const verification = output.trim() === "true";

    if (verification) {
      await prisma.challenge.update({
        where: { nonce: challenge },
        data: {
          signature,
        },
      });

      await prisma.$disconnect();

      const secret = process.env.COTURN_SECRET || "north";
      const date = Date.now();
      const unixTimeStamp = parseInt(String(date / 1000)) + 1 * 60 * 60; // two hours
      const username = [unixTimeStamp, fromPeerPublicKey].join(":");
      const hmac = crypto.createHmac("sha1", secret);

      hmac.setEncoding("base64");
      hmac.write(username);
      hmac.end();
      const credential = hmac.read();

      ws.send(
        JSON.stringify({
          type: "challenge",
          challengeId: correspondingChallengeId,
          username,
          credential,
        } as WebSocketMessageSuccessfulChallenge),
      );

      return;
    } else {
      await prisma.$disconnect();

      ws.send(
        JSON.stringify({
          type: "error",
          fromAction: "sendChallengeResponse",
          error: {
            message:
              "Challenge " +
              challenge +
              " response signature cannot be verified",
          },
        } as WebSocketMessageError),
      );

      ws.terminate();

      return;
    }
  } catch (error) {
    await prisma.$disconnect();

    ws.send(
      JSON.stringify({
        type: "error",
        fromAction: "sendChallengeResponse",
        error,
      } as WebSocketMessageError),
    );

    ws.terminate();
  }
};

export default handleChallenge;
