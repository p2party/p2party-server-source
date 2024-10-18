const arrayBufferToBase64String = (arrayBuffer: ArrayBuffer) => {
  var byteArray = new Uint8Array(arrayBuffer);
  var byteString = "";
  for (var i = 0; i < byteArray.byteLength; i++) {
    byteString += String.fromCharCode(byteArray[i]);
  }
  return btoa(byteString);
};

export const convertBinaryToPem = (
  binaryData: ArrayBuffer,
  label: "RSA PUBLIC KEY" | "RSA PRIVATE KEY",
) => {
  const base64Cert = arrayBufferToBase64String(binaryData);
  let pemCert = "-----BEGIN " + label + "-----\r\n";
  let nextIndex = 0;
  while (nextIndex < base64Cert.length) {
    if (nextIndex + 64 <= base64Cert.length) {
      pemCert += base64Cert.substring(nextIndex, 64) + "\r\n";
    } else {
      pemCert += base64Cert.substring(nextIndex) + "\r\n";
    }
    nextIndex += 64;
  }
  pemCert += "-----END " + label + "-----\r\n";
  return pemCert;
};

export const hexToArrayBuffer = (key: string) => {
  let k = key;
  if (key.startsWith("0x", 0)) k = key.substring(2);
  const arr = Uint8Array.from(
    k.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16)),
  );

  return arr.buffer;
};

export const convertHexToPem = (hexKey: string) => {
  const base64Cert = Buffer.from(hexKey, "hex").toString("base64");

  return `-----BEGIN PUBLIC KEY-----\n${base64Cert}\n-----END PUBLIC KEY-----`;
};

export const convertPemToHex = (pemKey: string) => {
  const base64Cert = pemKey
    .replace("-----BEGIN PUBLIC KEY-----\n", "")
    .replace("\n-----END PUBLIC KEY-----", "");

  return Buffer.from(base64Cert, "base64").toString("hex");
};
