# Isolated HTTPS origin for the static site

This standalone Terraform root describes a new private S3 bucket and a new CloudFront distribution on its own AWS hostname. The production server Terraform does not load it. The existing website, domain aliases, Cloudflare rules, production buckets and their policies are outside this root. Creating this stack would use billable AWS resources. The local checks below use a mocked provider and the compiled website.

## What the deployed site uses

On November 27, 2026, a read-only configuration check found proxied Cloudflare CNAME records for the apex, www, dev and CDN pointing to S3 website endpoints. The website deployment bucket has an index document, a custom error document and a public-read policy. S3 website endpoints support HTTP only. The available access allowed DNS and bucket reads. It did not permit inspection of effective Cloudflare origin overrides, Workers or the zone SSL mode. A browser TLS handshake establishes the visitor-to-edge transport. A cache hit can be served entirely at the edge. [AWS website endpoints](https://docs.aws.amazon.com/AmazonS3/latest/userguide/WebsiteEndpoints.html)

## How the stage serves the same release

CloudFront signs each request to the regional S3 REST endpoint using an origin access control with signing set to `always`. This setting selects HTTPS for the origin connection. The S3 policy limits object reads to this distribution's service principal and source ARN. The bucket blocks public access and CloudFront accepts HTTPS viewers. This protects the transport and authenticates the service. The CDN still supplies executable content to the browser. [CloudFront origin access controls](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-s3.html)

A viewer-request function uses the actual build's directory indexes. It rewrites both `/r` and `/r/` to `/r/index.html`, and makes the corresponding change for each prerendered page. The browser keeps its full URL. The room fragment stays local to the browser. The explorer can read `?receipt=1` at its original path. CloudFront requests the same static HTML for all receipt queries. Exact object paths, including extensionless Apple association and merchant files, pass through. Missing objects retain storage error semantics, typically HTTP 403 with a get-only REST policy. A missing association or asset must never return a successful HTML fallback. [CloudFront viewer-request functions](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/example_cloudfront_functions_url_rewrite_single_page_apps_section.html)

The cache policy has zero minimum and default TTL, and caps any declared lifetime at one year. The release uploader still supplies per-object cache control, type and encoding. Use the existing uploader or a copy process that preserves metadata. Include any protected merchant association files and historical downloads that exist only in object storage. A staging rollout also needs the frontend's existing security headers. The staging distribution uses the AWS hostname and its default certificate, and does not inherit the production Cloudflare header rules. [CloudFront expiration](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/Expiration.html)

## Local checks

Set `P2PARTY_SITE_DIST` to the absolute path of a completed website build with the room, explorer and Apple association files. From this directory with Terraform 1.7 or later and Node.js, run the following.

```sh
terraform init -backend=false
terraform fmt -check
terraform validate
terraform test -var='stage_name=p2party-origin-check' -var='region=us-east-1' -var="site_dist=$P2PARTY_SITE_DIST"
node --test route.test.mjs
```

The Terraform test uses a mocked AWS provider in plan mode. The Node test runs the rendered CloudFront function against the actual indexes, assets, association URLs, downloads, a missing path and a receipt query. Rebuild its route list whenever the set of prerendered directories changes.

## Production decisions

Before a cutover, each hostname needs an inventory of its redirects, header rules, cache behavior and existing Worker or origin overrides. Decide whether the current regional buckets and upload process should stay behind CloudFront or move to native Cloudflare hosting. A CloudFront pilot can use a separately named distribution and a copy of the reviewed release. Verify a real room link, receipt deep link, asset MIME/encoding and integrity, origin error responses, both app association paths and SDK downloads. Compare the stage's content hashes and metadata with the actual release.

A custom CloudFront endpoint requires a certificate covering each migrated hostname and an appropriate ACM certificate in us-east-1. Cloudflare must authenticate that origin under Full (strict). Migrate each service independently, retain the existing www-to-apex query-preserving redirect and confirm which other proxied hostnames a zone-wide mode change would affect. The existing website endpoint and bucket remain available as a rollback target during the transition. Block the old origin's public access only after the new origin is serving all required objects and rollback dependencies have been resolved. [CloudFront alternate domain names](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/CNAMEs.html) · [Cloudflare Full (strict)](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/)
