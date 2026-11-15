// #14 で承認した対応表だけを取得する。版とチェックサムは同時に更新すること。
export const GEYSER_SOURCE = {
  repository: "https://github.com/GeyserMC/mappings",
  revision: "e9271c00413bc75d0df5b3c4f1d9ca9c9764d4c7",
  javaVersion: "26.3",
  bedrockVersion: "1.26.60",
  sha256: {
    "blocks.nbt": "efc9305b53fc170dd153eb417e003a61f2b17f924592892726ecffc3dce58536",
    "items.json": "89ec17a95b005e5dac170d7834a18da79952c914e8f29201f6fe9a1cdb992179",
    "LICENSE": "4f49de5134b13de98672e8f870aae5d36f5b415086fb1c6fdf832b78c47c7094",
    "java-blocks.json": "7a0de8aaf7b04d00c40b8ffdc4cfe75184cff2e821d336a020573201867105a4",
  },
} as const;
