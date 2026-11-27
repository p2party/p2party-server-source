mock_provider "aws" {}

run "plan_isolated_origin" {
  command = plan

  assert {
    condition = (
      aws_s3_bucket_public_access_block.stage.block_public_acls &&
      aws_s3_bucket_public_access_block.stage.block_public_policy &&
      aws_s3_bucket_public_access_block.stage.ignore_public_acls &&
      aws_s3_bucket_public_access_block.stage.restrict_public_buckets &&
      !aws_s3_bucket.stage.force_destroy
    )
    error_message = "The staging bucket must reject public access and retain objects on teardown."
  }

  assert {
    condition = (
      aws_cloudfront_origin_access_control.stage.signing_behavior == "always" &&
      aws_cloudfront_origin_access_control.stage.signing_protocol == "sigv4" &&
      aws_cloudfront_origin_access_control.stage.origin_access_control_origin_type == "s3" &&
      aws_cloudfront_distribution.stage.default_cache_behavior[0].viewer_protocol_policy == "https-only" &&
      aws_cloudfront_distribution.stage.viewer_certificate[0].cloudfront_default_certificate &&
      try(length(aws_cloudfront_distribution.stage.aliases), 0) == 0
    )
    error_message = "Use a separate CloudFront hostname and signed S3 REST origin with HTTPS on both hops."
  }

  assert {
    condition = (
      aws_cloudfront_cache_policy.stage.min_ttl == 0 &&
      aws_cloudfront_cache_policy.stage.default_ttl == 0 &&
      aws_cloudfront_cache_policy.stage.max_ttl == 31536000 &&
      aws_cloudfront_cache_policy.stage.parameters_in_cache_key_and_forwarded_to_origin[0].query_strings_config[0].query_string_behavior == "none"
    )
    error_message = "Honor the uploader's no-store or immutable policy and keep static objects independent of receipt queries."
  }
}
