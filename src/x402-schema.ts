const NETWORK = "base";

const COIN_API_INPUT_SCHEMA = {
  bodyType: "json",
  bodyFields: {
    name: { type: "string", required: true },
    symbol: { type: "string", required: true },
    creator: { type: "string", description: "The address that can update token metadata. Default is the API caller." },
    imageUrl: { type: "string" },
    website: { type: "string" },
    docs: { type: "string" },
    twitter: { type: "string" },
    telegram: { type: "string" },
    discord: { type: "string" },
    description: { type: "string" }
  }
} as const;

const BUY_DESCRIPTION_TEMPLATE = "Buy {amount} USDC worth of tokens from the vending machine. The token launch must be open to buy, and the allocation cap must not have been reached.";

const BUY_INPUT_SCHEMA = {
  bodyType: "json",
  bodyFields: {
    token: { type: "string", description: "Token address", required: true },
    recipient: { type: "string", description: "Optional recipient address; default is the API caller" }
  }
} as const;

export const x402EndpointSchema = {
  "POST /x402/buy": {
    price: "$1.00",
    network: NETWORK,
    config: {
      discoverable: true,
      description: BUY_DESCRIPTION_TEMPLATE.replace("{amount}", "$1.00"),
      inputSchema: BUY_INPUT_SCHEMA
    }
  },

  "POST /x402/buy2x": {
    price: "$2.00",
    network: NETWORK,
    config: {
      discoverable: true,
      description: BUY_DESCRIPTION_TEMPLATE.replace("{amount}", "$2.00"),
      inputSchema: BUY_INPUT_SCHEMA
    }
  },

  "POST /x402/buy3x": {
    price: "$3.00",
    network: NETWORK,
    config: {
      discoverable: true,
      description: BUY_DESCRIPTION_TEMPLATE.replace("{amount}", "$3.00"),
      inputSchema: BUY_INPUT_SCHEMA
    }
  },

  "POST /x402/buy4x": {
    price: "$4.00",
    network: NETWORK,
    config: {
      discoverable: true,
      description: BUY_DESCRIPTION_TEMPLATE.replace("{amount}", "$4.00"),
      inputSchema: BUY_INPUT_SCHEMA
    }
  },

  "POST /x402/buy5x": {
    price: "$5.00",
    network: NETWORK,
    config: {
      discoverable: true,
      description: BUY_DESCRIPTION_TEMPLATE.replace("{amount}", "$5.00"),
      inputSchema: BUY_INPUT_SCHEMA
    }
  },

  "POST /x402/buy10x": {
    price: "$10.00",
    network: NETWORK,
    config: {
      discoverable: true,
      description: BUY_DESCRIPTION_TEMPLATE.replace("{amount}", "$10.00"),
      inputSchema: BUY_INPUT_SCHEMA
    }
  },

  "POST /x402/buy20x": {
    price: "$20.00",
    network: NETWORK,
    config: {
      discoverable: true,
      description: BUY_DESCRIPTION_TEMPLATE.replace("{amount}", "$20.00"),
      inputSchema: BUY_INPUT_SCHEMA
    }
  },

  "POST /x402/coin/test": {
    price: "$1.00",
    network: NETWORK,
    config: {
      discoverable: true,
      description: "Launch a token for testing and offer it for sale. 1 billion total supply. Sales cap is 4 USDC.",
      inputSchema: COIN_API_INPUT_SCHEMA
    }
  },

  "POST /x402/coin/sm": {
    price: "$5.00",
    network: NETWORK,
    config: {
      discoverable: true,
      description: "Launch a token and offer it for sale. 1 billion total supply. Sales cap is 4000 USDC. Initial FDV is $5000. Name and symbol are required. Other metadata fields can always be updated by the creator with the /metadata/update endpoint later.",
      inputSchema: COIN_API_INPUT_SCHEMA
    }
  },

  "POST /x402/coin/lg": {
    price: "$10.00",
    network: NETWORK,
    config: {
      discoverable: true,
      description: "Launch a token and offer it for sale. 1 billion total supply. Sales cap is 40000 USDC. Initial FDV is $50000. Name and symbol are required. Other metadata fields can always be updated by the creator with the /metadata/update endpoint later.",
      inputSchema: COIN_API_INPUT_SCHEMA
    }
  },

  "POST /x402/metadata/update": {
    price: "$1.00",
    network: NETWORK,
    config: {
      discoverable: true,
      description: "Update token metadata. You must be the token creator to call this endpoint.",
      inputSchema: {
        bodyType: "json",
        bodyFields: {
          token: { type: "string", description: "The token contract address, starting with 0x", required: true },
          imageUrl: { type: "string" },
          website: { type: "string" },
          docs: { type: "string" },
          twitter: { type: "string" },
          telegram: { type: "string" },
          discord: { type: "string" },
          description: { type: "string" }
        }
      }
    }
  },

  "POST /x402/launches": {
    price: "$0.01",
    network: NETWORK,
    config: {
      discoverable: true,
      description: "List token launches in the vending machine. Results include the token information and launch progress (amount of USDC raised, queued, and completed purchases). Useful for searching ongoing or completed launches, or to get the token information for a specific launch.",
      inputSchema: {
        bodyType: "json",
        bodyFields: {
          filter: {
            type: "string",
            enum: ["open", "graduated", "refundable"],
            description: "Filter launches: 'open' (not graduated, created within 14 days), 'graduated', 'refundable' (not graduated, older than 14 days). Omit to return all launches."
          }
        }
      }
    }
  },

  "POST /x402/token_info": {
    price: "$0.001",
    network: NETWORK,
    config: {
      discoverable: true,
      description: "Get detailed information about a specific token, including launch status and purchase statistics, and token metadata.",
      inputSchema: {
        bodyType: "json",
        bodyFields: {
          token: {
            type: "string",
            description: "The token contract address (e.g., 0x...)",
            required: true
          }
        }
      }
    }
  },

  "POST /x402/buy_status": {
    price: "$0.01",
    network: NETWORK,
    config: {
      discoverable: true,
      description: "Check the status of a purchase transaction.",
      inputSchema: {
        bodyType: "json",
        bodyFields: {
          reference: {
            type: "string",
            description: "The reference ID returned from the buy endpoint",
            required: true
          }
        }
      }
    }
  },

  "POST /x402/coin_status": {
    price: "$0.01",
    network: NETWORK,
    config: {
      discoverable: true,
      description: "Check the status of a coin creation. Returns the token contract address if it has been created.",
      inputSchema: {
        bodyType: "json",
        bodyFields: {
          reference: {
            type: "string",
            description: "The reference ID returned from the coin endpoint",
            required: true
          }
        }
      }
    }
  }
};
