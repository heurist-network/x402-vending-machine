
export enum LaunchStatus {
    open = 'open',
    graduated = 'graduated',
    refundable = 'refundable',
}

export interface SaleInfo {
    currentUSDC: string;
    targetUSDC: string;
    percent: string;
}

export interface PurchaseStats {
    totalPurchases: number;
    queuedPurchases: number;
}

export interface LaunchResponse {
    name: string;
    symbol: string;
    tokenAddress: string;
    creatorAddress: string;
    createdAt: string;
    status: LaunchStatus;
    sale: SaleInfo;
    marketCap: string;
}

export interface TokenDetailResponse extends LaunchResponse {
    contractUriData: ContractUriData | null;
    stats: PurchaseStats;
}

export interface ContractUriData {
    name?: string;
    symbol?: string;
    description?: string;
    image?: string;
    website?: string;
    twitter?: string;
    telegram?: string;
    [key: string]: any;
}

export interface PaginationInfo {
    currentPage: number;
    totalItems: number;
    totalPages: number;
}

export interface LaunchesResponse {
    data: LaunchResponse[];
    pagination: PaginationInfo;
}

export interface PlatformStatsResponse {
    totalRaisedUSDC: string;
    totalLaunches: number;
    graduatedLaunches: number;
    openLaunches: number;
}

export interface X402Kind {
    extra: Record<string, any>;
    network: string;
    scheme: string;
    x402Version: number;
}

export interface FacilitatorHealthResponse {
    kinds: X402Kind[];
}

export interface ErrorResponse {
    error: string;
    message?: string;
    details?: any;
}
