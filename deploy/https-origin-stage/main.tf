terraform {
  required_version = ">= 1.7.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "= 6.74.0"
    }
  }
}

variable "region" {
  description = "Region for a new staging bucket."
  type        = string
}

variable "stage_name" {
  description = "Unique prefix for the staging resources."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,22}[a-z0-9]$", var.stage_name))
    error_message = "Use three through 24 lowercase letters, digits or hyphens."
  }
}

variable "site_dist" {
  description = "Path to the completed public website build."
  type        = string

  validation {
    condition = alltrue([
      for key in ["index.html", "r/index.html", "explorer/testnet/index.html", ".well-known/apple-app-site-association"] :
      fileexists("${var.site_dist}/${key}")
    ])
    error_message = "Build the site first. Room and explorer indexes and the Apple association must exist."
  }
}

provider "aws" {
  region = var.region
}

locals {
  routes = {
    for key in fileset(var.site_dist, "**/index.html") :
    trimsuffix("/${key}", "/index.html") => "/${key}"
  }
  viewer_code = templatefile("${path.module}/viewer.js.tftpl", { routes = jsonencode(local.routes) })
}

resource "aws_s3_bucket" "stage" {
  bucket_prefix = "${var.stage_name}-"
  force_destroy = false
}

resource "aws_s3_bucket_public_access_block" "stage" {
  bucket                  = aws_s3_bucket.stage.id
  block_public_acls       = true
  ignore_public_acls      = true
  block_public_policy     = true
  restrict_public_buckets = true
}

resource "aws_cloudfront_origin_access_control" "stage" {
  name                              = var.stage_name
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_function" "route" {
  name    = "${var.stage_name}-route"
  runtime = "cloudfront-js-2.0"
  publish = true
  code    = local.viewer_code

  lifecycle {
    precondition {
      condition     = length(local.viewer_code) <= 10000 && can(regex("^[\\x00-\\x7f]*$", local.viewer_code))
      error_message = "The ASCII viewer function must fit the 10 KB CloudFront Function quota."
    }
  }
}

resource "aws_cloudfront_cache_policy" "stage" {
  name        = var.stage_name
  min_ttl     = 0
  default_ttl = 0
  max_ttl     = 31536000
  parameters_in_cache_key_and_forwarded_to_origin {
    enable_accept_encoding_brotli = true
    enable_accept_encoding_gzip   = true
    cookies_config {
      cookie_behavior = "none"
    }
    headers_config {
      header_behavior = "none"
    }
    query_strings_config {
      query_string_behavior = "none"
    }
  }
}

resource "aws_cloudfront_distribution" "stage" {
  enabled = true
  comment = "Isolated P2Party static origin test"

  origin {
    domain_name              = aws_s3_bucket.stage.bucket_regional_domain_name
    origin_id                = "private-rest-origin"
    origin_access_control_id = aws_cloudfront_origin_access_control.stage.id
  }

  default_cache_behavior {
    target_origin_id       = "private-rest-origin"
    viewer_protocol_policy = "https-only"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    cache_policy_id        = aws_cloudfront_cache_policy.stage.id
    compress               = true

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.route.arn
    }
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}

resource "aws_s3_bucket_policy" "stage" {
  bucket = aws_s3_bucket.stage.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "ReadFromStageDistribution"
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.stage.arn}/*"
      Condition = { StringEquals = { "AWS:SourceArn" = aws_cloudfront_distribution.stage.arn } }
    }]
  })
  depends_on = [aws_s3_bucket_public_access_block.stage]
}

output "stage_host" {
  value = aws_cloudfront_distribution.stage.domain_name
}

output "stage_bucket" {
  value = aws_s3_bucket.stage.id
}
