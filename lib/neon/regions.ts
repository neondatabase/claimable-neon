/** Regions that accept new projects. Azure regions are deprecated for project creation. */
export const REGIONS = [
	"aws-us-east-1",
	"aws-us-east-2",
	"aws-us-west-2",
	"aws-eu-central-1",
	"aws-eu-west-2",
	"aws-ap-southeast-1",
	"aws-ap-southeast-2",
	"aws-sa-east-1",
] as const;

export type RegionId = (typeof REGIONS)[number];
