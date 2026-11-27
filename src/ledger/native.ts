import { execFile } from "node:child_process";
import { bytes, RpcError, type LedgerConfig } from "./config";

export type StoredUnit = {
  id: Buffer;
  weight: string;
  suite: number;
  commitment: Buffer;
  created: string;
  spent: string | null;
};
export function validateTransfer(
  config: LedgerConfig,
  height: bigint,
  input: StoredUnit,
  wire: Buffer,
): Promise<{
  id: Buffer;
  outputId: Buffer;
  suite: number;
  commitment: Buffer;
}> {
  const prefix = Buffer.alloc(183);
  prefix.write("DLV1");
  bytes(config.chainId, 32).copy(prefix, 4);
  prefix[36] = config.spendMask;
  prefix[37] = config.receiveMask;
  prefix.writeBigUInt64BE(height, 38);
  input.id.copy(prefix, 46);
  prefix.writeBigUInt64BE(BigInt(input.weight), 110);
  prefix[118] = input.suite;
  input.commitment.copy(prefix, 119);
  return new Promise((resolve, reject) => {
    const child = execFile(
      config.verifier,
      [],
      {
        env: {},
        timeout: 3000,
        killSignal: "SIGKILL",
        maxBuffer: 512,
        encoding: "buffer",
      },
      (err, out) => {
        if (err || out.length !== 193 || (out[128] !== 1 && out[128] !== 2)) {
          reject(
            err?.code === 1
              ? new RpcError(-32010, "Transfer rejected")
              : new Error("Native verifier unavailable"),
          );
          return;
        }
        resolve({
          id: out.subarray(0, 64),
          outputId: out.subarray(64, 128),
          suite: out[128],
          commitment: out.subarray(129),
        });
      },
    );
    // Early rejection can close the pipe before the kernel has copied the request.
    child.stdin!.on("error", () => {});
    child.stdin!.end(Buffer.concat([prefix, wire]));
  });
}
