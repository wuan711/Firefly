import type { SponsorConfig } from "../types/sponsorConfig";

/**
 * 打赏页面已从站点移除。
 * 此文件仅作为配置桩保留，供文章详情页的条件引用使用；
 * siteConfig.pages.sponsor 为 false，所有打赏入口都不会渲染。
 */
export const sponsorConfig: SponsorConfig = {
	title: "",
	description: "",
	usage: "",
	showSponsorsList: false,
	showComment: false,
	showButtonInPost: false,
	methods: [],
	sponsors: [],
};
