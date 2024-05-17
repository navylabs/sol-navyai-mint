import { Logger, Injectable } from "@nestjs/common";
import { TelegramUserService } from "./telegram-user.service";
import { Connection, Keypair } from "@solana/web3.js";
import * as fs from "fs";
import * as mime from "mime-types";
import { ObjectCannedACL } from "aws-sdk/clients/s3";
import { InjectS3, S3 } from "nestjs-s3";
import axios from "axios";
import * as path from "path";
import * as anchor from "@project-serum/anchor";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  AuthorityType,
  setAuthority,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import * as mpl from "@metaplex-foundation/mpl-token-metadata";
import { makeid } from "../_utils/string.utils";
import { RedisActionService } from "./redis-action.service";
import { getBalance } from "../_utils/raydium.utils";
const web3 = require("@solana/web3.js");
const bs58 = require("bs58");

export class Mint {
  private readonly logger = new Logger(Mint.name);

  constructor(
    @InjectS3()
    private readonly s3: S3
  ) {}

  async reUploadToS3(
    src: string,
    filePath: string,
    s3Folder: string
  ): Promise<any> {
    //try {
    if (!fs.existsSync(process.env.ROOT_UPLOAD_FOLDER)) {
      fs.mkdirSync(process.env.ROOT_UPLOAD_FOLDER, { recursive: true });
    }

    let saveFilePath = path.join(
      process.env.ROOT_UPLOAD_FOLDER,
      `${s3Folder}${filePath}`
    );
    return new Promise((resolve, reject) => {
      axios({
        timeout: 10000,
        method: "get",
        url: src,
        responseType: "stream",
        headers: {
          "user-agent": `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/94.0.4606.81 Safari/537.36`,
          pragma: `no-cache`,
          "cache-control": `no-cache`,
        },
      })
        .then(function (response) {
          if (response.status == 200) {
            let file = fs.createWriteStream(saveFilePath);
            file.on("finish", resolve);
            file.on("error", reject);
            response.data.pipe(file);
          }
        })
        .catch((e) => {
          console.error(e);
          reject(e);
        });
    })
      .then(async () => {
        let image = await this.upload(saveFilePath, filePath, s3Folder);

        if (image) {
          return {
            ...image,
            src: `/${s3Folder}/${filePath}`,
          };
        }
        return null;
      })
      .catch((e) => {
        console.error(e);
        return null;
      });
  }

  async upload(
    sourcePath: string,
    filePath: string,
    s3Folder: string
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      try {
        let stat = fs.statSync(sourcePath);
        if (stat.size > 0) {
          var fileStream = fs.createReadStream(sourcePath);
          // This will wait until we know the readable stream is actually valid before piping
          let s3 = this.s3;
          fileStream.on("open", function () {
            let grant: ObjectCannedACL = "public-read";
            let contentType =
              mime.lookup(filePath) || "application/octet-stream";
            // console.log('contentType -> ', contentType);
            let params = {
              Body: fileStream,
              Key: (s3Folder ? `${s3Folder}/` : "") + filePath,
              Bucket: process.env.S3_BUCKET_NAME,
              ACL: grant,
              ContentType: contentType,
              ContentLength: stat.size,
            };
            s3.upload(params, (err: any, data: any) => {
              if (err) {
                reject(err);
                return;
              }
              //console.log('s3.upload done -> ', data);
              resolve(data);
            });
          });

          // This catches any errors that happen while creating the readable stream (usually invalid names)
          fileStream.on("error", function (err) {
            reject(err);
          });
        }
      } catch (e) {
        reject(e);
      }
    })
      .then((data) => {
        if (fs.existsSync(sourcePath)) {
          fs.unlinkSync(sourcePath);
        }
        return data;
      })
      .catch((e) => {
        this.logger.error(e);
        if (fs.existsSync(sourcePath)) {
          fs.unlinkSync(sourcePath);
        }
        return null;
      });
  }

  async uploadMetadaJson(metadata: any, folder: string) {
    let json = JSON.stringify(metadata);
    let filePath = path.join(process.env.ROOT_UPLOAD_FOLDER, `${folder}.json`);
    fs.writeFileSync(filePath, json);
    let jsonUri = await this.upload(filePath, `metadata.json`, folder);
    // console.log('jsonUri -> ', jsonUri);
    if (jsonUri) {
      return jsonUri.Location;
    }
  }

  async mintToken(bot: any, chatId: string, changeAuthority = false) {
    try {
      bot.sendMessage(chatId, `Sending your transaction...`);
      // Connect to cluster
      const connection = new Connection(
        process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com",
        "confirmed"
      );

      let conversation: any = {};

      let metadata: any = {
        name: conversation.name,
        symbol: conversation.symbol,
        image: conversation.image,
        description: conversation.description,
        decimals: conversation.decimals,
      };

      let uri = await this.uploadMetadaJson(metadata, conversation.folder);

      // Generate a new wallet keypair and airdrop SOL
      const fromWallet = Keypair.fromSecretKey(
        bs58.decode(conversation.privateKey)
      );

      // Create new token mint
      const mint = await createMint(
        connection,
        fromWallet,
        fromWallet.publicKey,
        null,
        9,
        Keypair.generate(),
        { commitment: "confirmed" },
        TOKEN_PROGRAM_ID
      );

      const fromTokenAccount = await getOrCreateAssociatedTokenAccount(
        connection,
        fromWallet,
        mint,
        fromWallet.publicKey,
        false,
        "confirmed",
        { commitment: "confirmed" }
      );

      let signature = await mintTo(
        connection,
        fromWallet,
        mint,
        fromTokenAccount.address,
        fromWallet.publicKey,
        Number(conversation.supply) * Number(10 ** 9),
        [],
        { commitment: "confirmed" },
        TOKEN_PROGRAM_ID
      );

      const seed1 = Buffer.from(anchor.utils.bytes.utf8.encode("metadata"));
      const seed2 = Buffer.from(mpl.PROGRAM_ID.toBytes());
      const seed3 = Buffer.from(mint.toBytes());
      const [metadataPDA, _bump] = web3.PublicKey.findProgramAddressSync(
        [seed1, seed2, seed3],
        mpl.PROGRAM_ID
      );
      const accounts: any = {
        metadata: metadataPDA,
        mint,
        mintAuthority: fromWallet.publicKey,
        payer: fromWallet.publicKey,
        updateAuthority: fromWallet.publicKey,
      };

      const args: mpl.CreateMetadataAccountV3InstructionArgs = {
        createMetadataAccountArgsV3: {
          data: {
            name: conversation.name || "",
            symbol: conversation.symbol || "",
            uri: uri || "",
            sellerFeeBasisPoints: 0,
            creators: null,
            collection: null,
            uses: null,
          },
          isMutable: true,
          collectionDetails: null,
        },
      };

      const tx = new web3.Transaction();
      let ix = mpl.createCreateMetadataAccountV3Instruction(accounts, args);
      tx.add(ix);
      await web3.sendAndConfirmTransaction(connection, tx, [fromWallet]);

      if (changeAuthority) {
        await setAuthority(
          connection,
          fromWallet,
          mint,
          fromWallet.publicKey,
          AuthorityType.MintTokens,
          null // this sets the mint authority to null
        );
      }
    } catch (e: any) {
      console.error(e);
      console.log("Lỗi -> " + e.toString());
      bot.sendMessage(chatId, `Error: ${e.toString()}`);
      bot.sendMessage(chatId, `Please check your balance and try again.`);
    }
  }

  getPublicKey(privateKey: string): string {
    if (!privateKey) {
      return privateKey;
    }
    const fromWallet = Keypair.fromSecretKey(bs58.decode(privateKey));
    return fromWallet.publicKey.toString();
  }
}
